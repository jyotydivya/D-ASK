// ─────────────────────────────────────────────────────────────────────────────
// AgentHost — protocol state machine around the existing AgentRuntime.
//
// It adds no planning, tool or verification logic and exposes no runtime internals:
// a request can only submit an objective, ask about it, cancel it, or stop the host.
// The reported outcome is exactly RunReport.outcome. Tool grants and the approval
// gate are fixed when the runtime is constructed; nothing in the protocol changes them.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../runtime/planner";
import type { AgentRuntime } from "../runtime/runtime";
import type { LanguageModel } from "../runtime/types";
import type { DaemonCallBridge } from "./desktopBridge";
import { runWorkflow } from "./workflowRun";
import { announceRefusal, fetchKnown, interpretWorkflowRequest, manageWorkflow, parseManageRequest, refusedManage } from "./workflowManage";
import { runWorkflowName } from "../runtime/tools/workflows";
import type { Artifact, ConversationTurn, RunOutcome, RunReport, RuntimeEvent } from "../runtime/types";
import { artifactOf } from "../runtime/artifact";
import { parseChain, prefixEvents, runChain, withPrefix } from "./compose";
import {
  MAX_LINE_BYTES, ProtocolError, encodeError, encodeEvent, encodeResult, parseReply, parseRequest,
  type GenerationParams, type HelloParams, type Request, type SubmitParams, type TaskRefParams,
} from "./protocol";

export interface HostDeps {
  /** Writes one complete protocol line. The only path to stdout. */
  writeLine(line: string): void;
  /** Diagnostics; never receives objectives, tool inputs or credentials. */
  log(message: string): void;
  /** The per-launch token the first request must present. */
  token: string;
  runtime: Pick<AgentRuntime, "run">;
  /**
   * Deterministic: true when the local knowledge engine (runtime/knowledge/service.ts) claims the request ("index …", "according to my
   * documents, …", "prepare a literature review …"). Such a request goes to the runtime directly and is never offered to workflow-management
   * interpretation, so a collection and a workflow that share a name cannot be confused. Absent: no knowledge engine.
   */
  knowledgeClaims?(objective: string): boolean;
  /** Safe model/supervisor status for `health` (must not contain credentials). */
  modelStatus?(): unknown;
  /** Release the model server. Called once on shutdown. */
  stopModel?(): Promise<void>;
  /** Ends the process. */
  exit(code: number): void;
  /** How long shutdown waits for an aborted task to report before exiting. */
  shutdownGraceMs?: number;
  /** Phase 7B.1b: read-only desktop calls to the daemon (protocol v2). Absent: v1 only. */
  desktop?: DaemonCallBridge;
  /**
   * The local model, used ONLY to describe a natural-language workflow-management request as untrusted JSON (workflowIntent.ts). The host validates
   * that description deterministically before any daemon call; the model has no authority and no tool access. Absent: only exact requests are understood.
   */
  model?: LanguageModel;
  /**
   * TEST-ONLY, opt-in (DASK_AGENT_INTENT_TRACE=1 via AgentHost:ExtraEnvironment): receives, for each task that reaches workflow-management routing, the request text,
   * the model's raw description and the host's decision, so an acceptance run can show exactly how a request was understood. Off by default (the host's log
   * never carries request text otherwise); it changes no behaviour and cannot influence the decision.
   */
  intentTrace?: (event: Record<string, unknown>) => void;
  /**
   * Phase 7B.3 diagnostics (test-only, off unless DASK_AGENT_DIAGNOSTICS=1): adds a `diag` object to progress events
   * with ids, tool names, salted input fingerprints and structured verification flags. Never inputs, text or titles.
   * Changes no behaviour: the runtime, planner, tools and approvals see nothing of it.
   */
  diagnostics?: boolean;
}

export type TaskState = "running" | "cancelling" | "finished";

/** What the caller sees of a run: outcomes and evidence, not raw tool outputs. */
export interface TaskResult {
  taskId: string;
  outcome: RunOutcome;
  response: string;
  iterations: number;
  toolCalls: number;
  error: string | null;
  steps: { id: string; tool: string; status: string; evidence: string | null; error: string | null }[];
  verification: {
    independentlyVerified: boolean;
    criteriaSatisfied: boolean | null;
    method: string;
    unexplained: string[];
    facets: { id: string; satisfied: boolean }[];
    grounding: { stepId: string; status: string }[];
  } | null;
  /** HOST-SIDE ONLY (never sent: stripped before task.finished): the typed result a later step may use (compose.ts). */
  artifact?: Artifact;
}

export function toTaskResult(r: RunReport, objective = ""): TaskResult {
  return {
    taskId: r.taskId,
    outcome: r.outcome,
    response: r.response,
    iterations: r.iterations,
    toolCalls: r.toolCalls,
    error: r.error ?? null,
    steps: r.steps.map((s) => ({ id: s.step.id, tool: s.step.tool, status: s.status, evidence: s.outcome?.evidence || null, error: s.error ?? null })),
    verification: r.verification && {
      independentlyVerified: r.verification.independentlyVerified,
      criteriaSatisfied: r.verification.criteriaSatisfied,
      method: r.verification.method,
      unexplained: r.verification.unexplained,
      facets: r.verification.facets.map((f) => ({ id: f.id, satisfied: f.satisfied })),
      grounding: r.verification.grounding.map((g) => ({ stepId: g.stepId, status: g.status })),
    },
    artifact: artifactOf(r, objective),
  };
}

interface TaskRecord {
  taskId: string;
  requestId: string;
  state: TaskState;
  controller: AbortController;
  seq: number;
  startedAt: number;
  result: TaskResult | null;
  done: Promise<void>;
}

const MAX_RETAINED = 64;
const sha256 = (s: string) => createHash("sha256").update(s).digest();

export class AgentHost {
  private authenticated = false;
  private shuttingDown = false;
  private stopped = false;
  private stopGeneration = 0;
  private readonly tasks = new Map<string, TaskRecord>();
  /** Every task id this process has accepted: a resubmitted id is refused, never run twice. */
  private readonly seenTaskIds = new Set<string>();
  private active: TaskRecord | null = null;
  private readonly startedAt = Date.now();
  /** This conversation's recent turns (typed, spoken, scheduled): planner context and the source of "save that …" / "remember that". In memory only. */
  private readonly turns: ConversationTurn[] = [];
  private lastTurn: { objective: string; result: TaskResult } | null = null;

  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;

  constructor(private readonly deps: HostDeps) {
    deps.desktop?.attach((l) => deps.writeLine(l));
  }

  // ── Framing ────────────────────────────────────────────────────────────────

  /** Feed raw stdin bytes. Splits on \n, enforces the line limit, never throws. */
  feed(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const part = chunk.subarray(start, end);
      if (!this.discarding) {
        if (this.pendingBytes + part.length > MAX_LINE_BYTES) {
          this.discarding = true;
          this.pending = [];
          this.pendingBytes = 0;
          this.deps.writeLine(encodeError(null, "message_too_large", `A line may not exceed ${MAX_LINE_BYTES} bytes`));
        } else {
          this.pending.push(part);
          this.pendingBytes += part.length;
        }
      }
      if (nl === -1) return;
      if (this.discarding) {
        this.discarding = false;
      } else {
        const line = Buffer.concat(this.pending).toString("utf8").replace(/\r$/, "");
        this.pending = [];
        this.pendingBytes = 0;
        if (line.trim() !== "") this.handleLine(line);
      }
      start = nl + 1;
    }
  }

  handleLine(line: string): void {
    // Phase 7B.1b: a daemon `reply` (v2) is routed to the bridge. Only after authentication, only when negotiated.
    if (line.includes('"reply"')) {
      let raw: unknown = null;
      try { raw = JSON.parse(line); } catch { /* falls through to the v1 parser's error */ }
      if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "reply") {
        try {
          const reply = parseReply(raw);
          if (reply && this.authenticated && this.deps.desktop?.available) this.deps.desktop.onReply(reply);
          else this.deps.writeLine(encodeError(null, "invalid_request", "Unexpected reply"));
        } catch (err) {
          this.deps.writeLine(encodeError(null, err instanceof ProtocolError ? err.code : "invalid_request", "Invalid reply"));
        }
        return;
      }
    }
    let req: Request;
    try {
      req = parseRequest(line);
    } catch (err) {
      if (err instanceof ProtocolError) this.deps.writeLine(encodeError(err.requestId, err.code, err.message));
      else this.deps.writeLine(encodeError(null, "internal_error", "Could not parse the request"));
      return;
    }
    try {
      this.dispatch(req);
    } catch (err) {
      // Details go to stderr only; a stack trace never reaches the protocol stream.
      this.deps.log(`internal error handling ${req.op}: ${err instanceof Error ? err.stack : String(err)}`);
      this.deps.writeLine(encodeError(req.id, "internal_error", `Internal error handling ${req.op}`));
    }
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  private dispatch(req: Request): void {
    if (!this.authenticated) {
      if (req.op === "hello") this.hello(req.id, req.params);
      else this.deps.writeLine(encodeError(req.id, "not_authenticated", "The first request must be a valid hello"));
      return;
    }
    switch (req.op) {
      case "hello": this.deps.writeLine(encodeError(req.id, "already_authenticated", "hello was already completed")); return;
      case "health": this.deps.writeLine(encodeResult(req.id, this.health())); return;
      case "submit": this.submit(req.id, req.params); return;
      case "status": this.status(req.id, req.params); return;
      case "cancel": this.cancel(req.id, req.params); return;
      case "emergency_stop": this.emergencyStop(req.id, req.params); return;
      case "resume": this.resume(req.id, req.params); return;
      case "shutdown": this.deps.writeLine(encodeResult(req.id, { shuttingDown: true })); void this.shutdown("shutdown request", 0); return;
    }
  }

  private hello(id: string, p: HelloParams): void {
    if (!timingSafeEqual(sha256(p.token), sha256(this.deps.token))) {
      this.deps.writeLine(encodeError(id, "authentication_failed", "Invalid token"));
      this.deps.log("hello rejected: invalid token; exiting");
      this.deps.exit(3);
      return;
    }
    this.authenticated = true;
    // Phase 7B.1b: echo the agreed desktop offer; the daemon enables v2 calls only when it sees this.
    if (p.desktop && this.deps.desktop) this.deps.desktop.enable(p.desktop.tools);
    // The daemon is the Emergency Stop authority: a host started during a stop starts stopped.
    this.stopped = p.emergencyStopped;
    this.stopGeneration = p.stopGeneration;
    this.deps.writeLine(encodeResult(id, this.health()));
  }

  private health() {
    return {
      protocol: 1,
      pid: process.pid,
      ready: !this.shuttingDown,
      shuttingDown: this.shuttingDown,
      emergencyStopped: this.stopped,
      stopGeneration: this.stopGeneration,
      activeTaskId: this.active?.taskId ?? null,
      uptimeMs: Date.now() - this.startedAt,
      rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      model: this.deps.modelStatus?.() ?? null,
      ...(this.deps.desktop?.offered() ? { desktop: this.deps.desktop.offered() } : {}),
    };
  }

  private submit(id: string, p: SubmitParams): void {
    if (this.shuttingDown) { this.deps.writeLine(encodeError(id, "shutting_down", "The host is shutting down")); return; }
    if (this.stopped) { this.deps.writeLine(encodeError(id, "emergency_stopped", "Emergency Stop is active; new tasks are refused")); return; }
    if (this.seenTaskIds.has(p.taskId)) { this.deps.writeLine(encodeError(id, "duplicate_task", `Task ${p.taskId} was already submitted; it will not run again`)); return; }
    if (this.active) { this.deps.writeLine(encodeError(id, "busy", `Task ${this.active.taskId} is still running; only one task runs at a time`)); return; }

    const controller = new AbortController();
    const rec: TaskRecord = { taskId: p.taskId, requestId: id, state: "running", controller, seq: 0, startedAt: Date.now(), result: null, done: Promise.resolve() };
    this.seenTaskIds.add(p.taskId);
    this.tasks.set(p.taskId, rec);
    this.active = rec;
    this.deps.writeLine(encodeResult(id, { accepted: true, taskId: p.taskId }));
    this.deps.log(`task ${p.taskId} accepted`);
    rec.done = this.runTask(rec, p.objective);
  }

  private async runTask(rec: TaskRecord, objective: string): Promise<void> {
    let lastPhase = "none"; // diagnostics only: the last phase reached, to locate a failure
    let plans = 0;
    const emit = (e: RuntimeEvent) => {
      if (e.type === "phase") lastPhase = e.phase;
      if (e.type === "plan") plans++;
      const data = progressOf(e, this.deps.diagnostics === true);
      if (data) this.deps.writeLine(encodeEvent("task.progress", rec.requestId, rec.taskId, ++rec.seq, data));
    };
    let result: TaskResult;
    try {
      // "<request>, then save it as a note called T" / "... and remember it" / "save that as ..." (compose.ts). The first part runs through execute(), exactly
      // as if typed. The saving part (always a note or memory request built by compose.ts) goes straight to the runtime: the workflow-management router
      // must never read the quoted note CONTENT as an instruction (found in the real HUD: an answer citing "§ … > Schedule" was refused as a workflow request).
      const chain = parseChain(objective);
      result = chain
        ? await runChain(chain, { taskId: rec.taskId, previous: this.lastTurn, signal: rec.controller.signal, run: (o, prefix) => prefix
            ? (async () => withPrefix(toTaskResult(await this.deps.runtime.run({ taskId: rec.taskId, objective: o, signal: rec.controller.signal, sink: { emit: prefixEvents(emit, prefix) }, history: this.history() }), o), prefix))()
            : this.execute(rec, o, emit, "") })
        : await this.execute(rec, objective, emit, "");
    } catch (err) {
      // AgentRuntime.run does not throw by design. Never report this as anything but a failure.
      this.deps.log(`task ${rec.taskId} runtime failure: ${err instanceof Error ? err.stack : String(err)}`);
      result = { taskId: rec.taskId, outcome: "failed", response: "I couldn't complete this.", iterations: 0, toolCalls: 0, error: "Agent runtime failure", steps: [], verification: null };
    }
    rec.result = result;
    rec.state = "finished";
    this.turns.push({ objective, outcome: result.outcome, response: result.response.slice(0, 600) });
    if (this.turns.length > 10) this.turns.shift();
    this.lastTurn = { objective, result };
    if (this.active === rec) this.active = null;
    this.deps.writeLine(encodeEvent("task.finished", rec.requestId, rec.taskId, ++rec.seq, { ...result, artifact: undefined }));
    this.deps.log(`task ${rec.taskId} finished: ${result.outcome} in ${Date.now() - rec.startedAt} ms` +
      // Diagnostics (opt-in): where it stopped and the error's leading category only (never its body, which may quote the request).
      (this.deps.diagnostics === true ? ` [diag lastPhase=${lastPhase} plans=${plans} errorKind=${result.error ? JSON.stringify(result.error.split(":")[0]!.slice(0, 60)) : "none"}]` : ""));
    this.prune();
  }


  /** One request through the normal routing (workflow run, knowledge, workflow management, runtime). Used for typed requests and for each part of a chain. */
  private async execute(rec: TaskRecord, objective: string, emit: (e: RuntimeEvent) => void, prefix: string): Promise<TaskResult> {
      // "Run the workflow X": its steps (read from the daemon) run one by one through the same runtime.
      const workflow = runWorkflowName(objective);
      if (workflow !== null) return withPrefix(await runWorkflow(workflow, { runtime: this.deps.runtime, desktop: this.deps.desktop }, rec.taskId, rec.controller.signal, emit, this.lastTurn), prefix);
      if (this.deps.knowledgeClaims?.(objective) === true) return withPrefix(toTaskResult(await this.deps.runtime.run({ taskId: rec.taskId, objective, signal: rec.controller.signal, sink: { emit }, history: this.history() }), objective), prefix);
      {
        // Save / list / delete / schedule / unschedule a workflow. Exact requests are the one call they state; other natural phrasings are described by
        // the local model, validated by the host, and only then turned into the same daemon call. Nothing here asks the planner to plan these.
        const signal = rec.controller.signal;
        const known = await fetchKnown(this.deps.desktop, rec.taskId, signal);
        const manage = parseManageRequest(objective, known ?? []);
        const trace = this.deps.intentTrace ? (e: Record<string, unknown>) => { try { this.deps.intentTrace!({ taskId: rec.taskId, objective, ...e }); } catch { /* tracing never affects a task */ } } : undefined;
        trace?.({ stage: "exact-parse", knownWorkflows: known === null ? null : known.length, parse: manage.kind === "route" ? { kind: "route", op: manage.op, name: manage.name } : manage.kind === "refuse" ? { kind: "refuse", soft: manage.soft === true, reason: manage.reason } : { kind: "none" } });
        if (manage.kind === "route") return withPrefix(await manageWorkflow(manage.op, manage.name, objective, { desktop: this.deps.desktop }, rec.taskId, signal, emit), prefix);
        if (manage.kind === "refuse" && !manage.soft) { announceRefusal(emit, manage.reason); return refusedManage(manage.reason, rec.taskId); }
        {
          const nl = known ? await interpretWorkflowRequest(objective, known, { desktop: this.deps.desktop, model: this.deps.model, trace, emit }, rec.taskId, signal) : null;
          if (!nl && manage.kind !== "refuse") trace?.({ stage: "runtime", note: "not claimed as workflow management: sent to the normal runtime" });
          return withPrefix(nl ?? (manage.kind === "refuse" ? (announceRefusal(emit, manage.reason), refusedManage(manage.reason, rec.taskId)) : toTaskResult(await this.deps.runtime.run({ taskId: rec.taskId, objective, signal, sink: { emit }, history: this.history() }), objective)), prefix);
        }
      }
  }

  /** The recent turns of this conversation, offered to the planner as context (advisory; grounding still uses only the request). */
  private history(): ConversationTurn[] { return this.turns.slice(-5); }

  private prune(): void {
    if (this.tasks.size <= MAX_RETAINED) return;
    for (const [k, t] of this.tasks) {
      if (t.state === "finished") { this.tasks.delete(k); if (this.tasks.size <= MAX_RETAINED) break; }
    }
  }

  private status(id: string, p: TaskRefParams): void {
    const t = this.tasks.get(p.taskId);
    if (!t) { this.deps.writeLine(encodeError(id, "unknown_task", `No task ${p.taskId}`)); return; }
    this.deps.writeLine(encodeResult(id, { taskId: t.taskId, state: t.state, elapsedMs: Date.now() - t.startedAt, result: t.result }));
  }

  private cancel(id: string, p: TaskRefParams): void {
    const t = this.tasks.get(p.taskId);
    if (!t) { this.deps.writeLine(encodeError(id, "unknown_task", `No task ${p.taskId}`)); return; }
    if (t.state === "finished") { this.deps.writeLine(encodeResult(id, { taskId: t.taskId, cancelling: false, state: t.state })); return; }
    t.state = "cancelling";
    t.controller.abort(new Error("cancelled by caller"));
    this.deps.writeLine(encodeResult(id, { taskId: t.taskId, cancelling: true, state: t.state }));
  }

  private emergencyStop(id: string, p: GenerationParams): void {
    // Always stops, whatever the generation says: a stop is never refused.
    this.stopped = true;
    this.stopGeneration = Math.max(this.stopGeneration, p.generation);
    const aborted = this.abortActive("emergency stop");
    this.deps.log(`emergency stop generation ${this.stopGeneration}; aborted ${aborted.length} task(s)`);
    this.deps.writeLine(encodeResult(id, { stopped: true, generation: this.stopGeneration, abortedTasks: aborted }));
  }

  private resume(id: string, p: GenerationParams): void {
    if (p.generation !== this.stopGeneration) {
      this.deps.writeLine(encodeError(id, "stale_generation", `Resume generation ${p.generation} does not match the current generation ${this.stopGeneration}`));
      return;
    }
    this.stopped = false;
    this.deps.log(`resumed at generation ${this.stopGeneration}`);
    this.deps.writeLine(encodeResult(id, { stopped: false, generation: this.stopGeneration }));
  }

  private abortActive(reason: string): string[] {
    const t = this.active;
    if (!t || t.state === "finished") return [];
    t.state = "cancelling";
    t.controller.abort(new Error(reason));
    return [t.taskId];
  }

  /** Abort work, let it report, release the model, exit. Idempotent. Used by shutdown and stdin EOF. */
  async shutdown(reason: string, code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.deps.log(`shutting down: ${reason}`);
    const running = this.active;
    this.abortActive(reason);
    // Outstanding daemon calls fail now (the daemon side is cancelled by the host's exit); never a late success.
    this.deps.desktop?.failAll("The agent host is shutting down.");
    if (running) {
      const grace = this.deps.shutdownGraceMs ?? 2_000;
      await Promise.race([running.done, new Promise((r) => setTimeout(r, grace))]);
    }
    try { await this.deps.stopModel?.(); } catch (err) { this.deps.log(`stopping the model failed: ${String(err)}`); }
    this.deps.exit(code);
  }
}

/** Progress for the caller: phases and step status. No tool inputs, no raw outputs. */
function progressOf(e: RuntimeEvent, diagnostics = false): unknown {
  const base = progressBase(e);
  if (!diagnostics || !base) return base;
  if (e.type === "plan") {
    return { ...(base as object), diag: {
      inputFingerprints: e.plan.steps.map((s) => ({ stepId: s.id, tool: s.tool, fp: inputFingerprint(s.tool, s.input) })),
      dependsOn: e.plan.steps.map((s) => ({ stepId: s.id, on: s.dependsOn ?? [] })),
      removedDuplicateSteps: e.plan.removedDuplicateSteps ?? [],
    } };
  }
  if (e.type === "verification") {
    const r = e.report;
    return { ...(base as object), diag: {
      needsMoreSteps: r.needsMoreSteps, criteriaSatisfied: r.criteriaSatisfied, method: r.method,
      stepsSucceeded: r.stepsSucceeded, stepsTotal: r.stepsTotal, missingCount: r.missing.length, unexplainedCount: r.unexplained.length,
      // Facet ids can embed a requested window title, so only a keyed fingerprint is emitted (correlates across rounds).
      facets: r.facets.map((f) => ({ fp: inputFingerprint("facet", f.id), satisfied: f.satisfied })), grounding: r.grounding.map((g) => ({ stepId: g.stepId, status: g.status })),
    } };
  }
  return base;
}

/** Per-process random key: fingerprints correlate steps within one host process and cannot be reversed or compared across runs. */
const DIAG_KEY = randomBytes(32);
function inputFingerprint(tool: string, input: unknown): string {
  return createHmac("sha256", DIAG_KEY).update(`${tool}|${canonicalJson(input)}`).digest("hex").slice(0, 16);
}

function progressBase(e: RuntimeEvent): unknown {
  switch (e.type) {
    case "phase": return { type: "phase", phase: e.phase };
    case "plan": return { type: "plan", iteration: e.iteration, intent: e.plan.intent, goal: e.plan.goal, tools: e.plan.steps.map((s) => s.tool), stepIds: e.plan.steps.map((s) => s.id) };
    case "step.started": return { type: "step.started", stepId: e.stepId, tool: e.tool };
    case "step.finished": return { type: "step.finished", stepId: e.stepId, tool: e.tool, status: e.status, durationMs: e.durationMs };
    case "approval.denied": return { type: "approval.denied", stepId: e.stepId, tool: e.tool };
    case "verification": return { type: "verification", independentlyVerified: e.report.independentlyVerified };
    case "finished": return null; // reported by task.finished
  }
}

