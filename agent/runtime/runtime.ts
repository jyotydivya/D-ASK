// ─────────────────────────────────────────────────────────────────────────────
// AgentRuntime — orchestration only.
//
//   understand+plan (Planner/Brain) → execute steps (ToolRegistry)
//     → observe/verify (Verifier) → [bounded follow-up round] → respond
//
// Loop control is explicit and bounded: maxIterations rounds, maxToolCalls tool
// executions, maxStepsPerPlan per plan, runTimeoutMs wall clock. Cancellation is
// an AbortSignal threaded through every model and tool call.
// ─────────────────────────────────────────────────────────────────────────────

import { Brain } from "./brain";
import { Planner } from "./planner";
import { DENY_ALL_APPROVALS, ToolRegistry, errMessage } from "./toolRegistry";
import { Verifier, decideOutcome, evidenceLines, judgeStep } from "./verifier";
import { checkArguments, clarificationFor, detectFacets, type ArgumentDomains } from "./grounding";
import { assessCapability } from "./capabilityCheck";
import {
  DEFAULT_LIMITS,
  type ApprovalGate,
  type ConversationTurn,
  type EventSink,
  type LanguageModel,
  type Plan,
  type PlanningMemorySource,
  type RunOutcome,
  type RunReport,
  type RuntimeEvent,
  type RuntimeLimits,
  type StepState,
  type ToolPermission,
  type VerificationReport,
} from "./types";

export interface RuntimeConfig {
  model: LanguageModel;
  registry: ToolRegistry;
  granted: ReadonlySet<ToolPermission>;
  approvalGate?: ApprovalGate;
  limits?: Partial<RuntimeLimits>;
  /**
   * Product default true: request-derived argument domains are enforced in the
   * output schema, at plan validation and immediately before each tool call.
   * false exists ONLY for research ablations.
   */
  argumentConstraints?: boolean;
  /**
   * Product default true: offer the model only the tools whose request check recognised part of the request
   * (Planner.toolsFor). false exists ONLY for research ablations.
   */
  requestToolOffer?: boolean;
  /**
   * The user's saved local memories as advisory planning context. Used only when `granted` includes memory:read.
   * Never affects argument domains, grounding, verification or approvals.
   */
  memory?: PlanningMemorySource;
  /**
   * EXPERIMENTAL switches, all OFF by default until a benchmark shows they help.
   * Fail-closed completion verification is NOT among them: it is always on.
   */
  experimental?: {
    /** Planner rejects plans with "contradicted" steps and spends its repair round on them. */
    planGrounding?: boolean;
    /** Deterministic gaps (uncovered request facets, contradicted steps) trigger a follow-up round. */
    gapReplanning?: boolean;
    /** Refuse clearly unsupported requests before planning (capabilityCheck.ts). It can only refuse. */
    capabilityCheck?: boolean;
  };
}

export interface RunOptions {
  taskId: string;
  objective: string;
  history?: ConversationTurn[];
  signal?: AbortSignal;
  sink?: EventSink;
}

const NULL_SINK: EventSink = { emit() {} };

export class AgentRuntime {
  readonly limits: RuntimeLimits;
  private readonly brain: Brain;
  private readonly planner: Planner;
  private readonly verifier: Verifier;
  private readonly approvalGate: ApprovalGate;

  constructor(private readonly config: RuntimeConfig) {
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.brain = new Brain(config.model, this.limits.modelTimeoutMs);
    this.planner = new Planner(this.brain, config.registry, {
      groundingCheck: config.experimental?.planGrounding ?? false,
      argumentConstraints: config.argumentConstraints ?? true,
      requestToolOffer: config.requestToolOffer ?? true,
    });
    this.verifier = new Verifier(this.brain, config.registry, { gapFeedback: config.experimental?.gapReplanning ?? false });
    this.approvalGate = config.approvalGate ?? DENY_ALL_APPROVALS;
  }

  async run(opts: RunOptions): Promise<RunReport> {
    const sink = opts.sink ?? NULL_SINK;
    const emit = (e: RuntimeEvent) => { try { sink.emit(e); } catch { /* a broken sink never breaks a run */ } };

    // One controller for the whole run: aborted by the caller or by the run time limit.
    const run = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => run.abort(new Error("cancelled"));
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (opts.signal?.aborted) run.abort(new Error("cancelled"));
    const deadline = setTimeout(() => { timedOut = true; run.abort(new Error("run time limit")); }, this.limits.runTimeoutMs);

    const steps: StepState[] = [];
    let firstPlan: Plan | null = null;
    let lastPlan: Plan | null = null;
    let verification: VerificationReport | null = null;
    let toolCalls = 0;
    let iterations = 0;
    let error: string | undefined;
    let refused = false;
    let memoryContext: { lines: string[]; ids: string[] } | null = null;

    try {
      emit({ type: "phase", phase: "understanding" });

      if (this.config.experimental?.capabilityCheck) {
        const capability = assessCapability(this.config.registry, opts.objective);
        if (capability.verdict === "unsupported") {
          const plan: Plan = {
            intent: "unsupported",
            goal: opts.objective.slice(0, 300),
            refusalReason: `No available tool can do this (${capability.signals.join(", ")}).`,
            successCriteria: [],
            steps: [],
          };
          refused = true;
          firstPlan = plan;
          lastPlan = plan;
          emit({ type: "plan", plan, iteration: 0 });
        }
      }

      // A request that refers to something it does not identify ("this report") is answered with a question,
      // before the model is asked anything, so no tool can pick a target on its behalf.
      if (!refused) {
        const question = clarificationFor(this.config.registry, opts.objective);
        if (question) {
          const plan: Plan = {
            intent: "unsupported",
            goal: opts.objective.slice(0, 300),
            refusalReason: "The request does not identify what it refers to.",
            clarification: question,
            successCriteria: [],
            steps: [],
          };
          refused = true;
          firstPlan = plan;
          lastPlan = plan;
          emit({ type: "plan", plan, iteration: 0 });
        }
      }

      if (!refused && this.config.memory && this.config.granted.has("memory:read")) {
        try { memoryContext = this.config.memory.contextFor(opts.objective); } catch { memoryContext = null; }
        if (memoryContext && memoryContext.lines.length === 0) memoryContext = null;
      }

      for (let iteration = 1; iteration <= this.limits.maxIterations && !refused; iteration++) {
        if (run.signal.aborted) break;
        iterations = iteration;
        emit({ type: "phase", phase: iteration === 1 ? "planning" : "replanning" });

        const performed = steps.filter((s) => s.status === "succeeded").map((s) => ({ id: s.step.id, tool: s.step.tool, input: s.step.input }));
        // An explicit ordered request whose remaining steps are fully determined by the request continues deterministically
        // (no model re-plan): the small local model was observed to omit or repeat them. Validated like any plan.
        const continuation = iteration > 1 && verification ? this.orderedContinuation(opts.objective, steps, verification) : null;
        const planned = continuation
          ? (() => {
              const c = this.planner.check(continuation, { maxSteps: this.limits.maxStepsPerPlan, granted: this.config.granted, idPrefix: `r${iteration}_`, performed, objective: opts.objective });
              return c.ok ? { ok: true as const, plan: c.plan, attempts: 0 } : { ok: false as const, error: c.errors.join("; "), attempts: 0 };
            })()
          : await this.planner.createPlan({
          objective: opts.objective,
          history: (opts.history ?? []).slice(-5),
          observations: iteration > 1
            ? [...evidenceLines(steps), ...(verification?.missing ?? []).map((m) => `STILL REQUIRED: ${m}`)]
            : undefined,
          maxSteps: this.limits.maxStepsPerPlan,
          granted: this.config.granted,
          idPrefix: iteration > 1 ? `r${iteration}_` : undefined,
          ...(iteration > 1 ? { performed } : {}),
          ...(memoryContext ? { memory: memoryContext.lines } : {}),
          signal: run.signal,
        });

        if (!planned.ok) {
          if (run.signal.aborted) break;
          // First round: nothing ran. Later rounds: keep what earlier rounds achieved.
          error = iteration === 1 ? `Planning failed: ${planned.error}` : `Follow-up planning failed: ${planned.error}`;
          break;
        }

        const plan = planned.plan;
        if (plan.intent === "unsupported") {
          if (iteration === 1) { refused = true; firstPlan = plan; lastPlan = plan; }
          emit({ type: "plan", plan, iteration });
          break;
        }

        firstPlan ??= plan;
        lastPlan = plan;
        emit({ type: "plan", plan, iteration });
        emit({ type: "phase", phase: "executing" });

        const round: StepState[] = plan.steps.map((step) => ({ step, status: "pending", attempt: 0 }));
        steps.push(...round);
        toolCalls = await this.executeRound(opts.taskId, round, toolCalls, run.signal, emit, this.planner.domainsFor(opts.objective), opts.objective);

        if (run.signal.aborted) break;

        emit({ type: "phase", phase: "verifying" });
        const criteria = Array.from(new Set(steps.length === round.length ? plan.successCriteria : [...(firstPlan.successCriteria), ...plan.successCriteria]));
        verification = await this.verifier.assess(opts.objective, { ...plan, successCriteria: criteria }, steps, run.signal);
        emit({ type: "verification", report: verification });

        // Phase 7B.3: a task that is already complete by the outcome rule (deterministic, task-level independent verification
        // AND the model's agreement; decideOutcome's "completed") starts no further round. The model's own needsMoreSteps
        // is advisory and was observed contradicting both (local model: criteriaSatisfied=true, needsMoreSteps=true, junk
        // `missing`). criteriaSatisfied alone never stops a round; independentlyVerified alone never does either.
        // Deterministic gaps make independentlyVerified false, so they still continue.
        const alreadyComplete = verification.independentlyVerified === true && verification.criteriaSatisfied === true;
        const canContinue = verification.needsMoreSteps
          && !alreadyComplete
          && iteration < this.limits.maxIterations
          && toolCalls < this.limits.maxToolCalls;
        if (!canContinue) break;
      }
    } catch (err) {
      error = `Runtime error: ${errMessage(err)}`;
    } finally {
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }

    // Anything still pending after an abort was never run. Every step gets a terminal
    // event, so observers (task model, UI) never show a step as pending forever.
    for (const s of steps) {
      if (s.status === "pending" || s.status === "running") {
        s.status = timedOut ? "skipped" : "cancelled";
        s.error = timedOut ? "Run time limit reached before this step ran" : "Cancelled before this step ran";
        emit({ type: "step.finished", stepId: s.step.id, tool: s.step.tool, status: s.status, error: s.error, durationMs: 0 });
      }
    }

    const cancelled = !timedOut && (opts.signal?.aborted ?? false);
    if (timedOut) error ??= `Run time limit (${this.limits.runTimeoutMs} ms) reached`;

    let outcome: RunOutcome = refused ? "refused" : decideOutcome(steps, verification, cancelled);
    if (!refused && !cancelled && steps.length === 0) outcome = "failed";

    const report: RunReport = {
      taskId: opts.taskId,
      outcome,
      plan: lastPlan ?? firstPlan,
      steps,
      verification,
      response: composeResponse(outcome, firstPlan ?? lastPlan, steps, verification, error) +
        (memoryContext && !refused ? `\n(Considered ${memoryContext.ids.length} of your saved note${memoryContext.ids.length === 1 ? "" : "s"} while planning.)` : ""),
      iterations,
      toolCalls,
      ...(error ? { error } : {}),
      ...(memoryContext ? { memoryContext: { ids: memoryContext.ids } } : {}),
    };
    await this.config.registry.endTask(opts.taskId);
    emit({ type: "finished", report });
    return report;
  }

  /**
   * A follow-up plan for the not-yet-performed steps of an explicitly ordered request, or null. Only when: every executed
   * step succeeded, nothing contradicted the request, the only uncovered facets are ordered-sequence facets, and the tool
   * of EACH remaining facet derives its exact input from the request (ToolRequestCheck.stepFor). Otherwise the model plans.
   */
  private orderedContinuation(objective: string, steps: StepState[], v: VerificationReport): unknown | null {
    if (steps.length === 0 || steps.some((s) => s.status !== "succeeded")) return null;
    if (v.grounding.some((g) => g.status !== "grounded")) return null;
    const facets = detectFacets(this.config.registry, objective);
    const unsatisfied = new Set(v.facets.filter((f) => !f.satisfied).map((f) => f.id));
    const pending = facets.filter((f) => unsatisfied.has(f.id));
    if (pending.length === 0 || pending.some((f) => !f.sequence)) return null;
    pending.sort((a, b) => a.sequence!.index - b.sequence!.index);
    const out: { id: string; tool: string; description: string; input: Record<string, unknown> }[] = [];
    for (const f of pending) {
      let input: Record<string, unknown> | null = null;
      try { input = this.config.registry.get(f.tool)?.requestCheck?.stepFor?.(f, objective) ?? null; } catch { input = null; }
      if (!input) return null;
      out.push({ id: `s${out.length + 1}`, tool: f.tool, description: f.description, input });
    }
    return { intent: "task", goal: objective.slice(0, 300), successCriteria: [], steps: out };
  }

  private async executeRound(
    taskId: string,
    round: StepState[],
    toolCallsSoFar: number,
    signal: AbortSignal,
    emit: (e: RuntimeEvent) => void,
    domains: ArgumentDomains,
    objective?: string,
  ): Promise<number> {
    let toolCalls = toolCallsSoFar;
    const byId = new Map(round.map((s) => [s.step.id, s]));

    // Plans are validated so dependencies only point backwards: plan order is a valid topological order.
    for (const state of round) {
      if (signal.aborted) break;

      const blocked = state.step.dependsOn.find((d) => byId.get(d)?.status !== "succeeded");
      if (blocked) {
        state.status = "skipped";
        state.error = `Depends on step ${blocked}, which did not succeed`;
        emit({ type: "step.finished", stepId: state.step.id, tool: state.step.tool, status: state.status, error: state.error, durationMs: 0 });
        continue;
      }
      if (toolCalls >= this.limits.maxToolCalls) {
        state.status = "skipped";
        state.error = `Tool-call budget (${this.limits.maxToolCalls}) exhausted`;
        emit({ type: "step.finished", stepId: state.step.id, tool: state.step.tool, status: state.status, error: state.error, durationMs: 0 });
        continue;
      }
      // Last check before execution: arguments must come from the request where it determines them.
      const argError = checkArguments(domains, state.step.tool, state.step.input);
      if (argError) {
        state.status = "failed";
        state.error = `Not executed: ${argError}`;
        emit({ type: "step.finished", stepId: state.step.id, tool: state.step.tool, status: state.status, error: state.error, durationMs: 0 });
        continue;
      }

      state.status = "running";
      state.attempt += 1;
      state.startedAt = Date.now();
      emit({ type: "step.started", stepId: state.step.id, tool: state.step.tool, description: state.step.description, input: state.step.input });

      toolCalls += 1;
      const result = await this.config.registry.invoke(state.step.tool, state.step.input, {
        taskId,
        stepId: state.step.id,
        signal,
        ...(objective !== undefined ? { objective } : {}),
        granted: this.config.granted,
        approvalGate: this.approvalGate,
      });
      if (result.status === "approval_denied") {
        emit({ type: "approval.denied", stepId: state.step.id, tool: state.step.tool, reason: result.outcome.error ?? "denied" });
      }

      const verdict = judgeStep(this.config.registry.get(state.step.tool), state.step.input, result);
      state.status = verdict.status;
      state.outcome = result.outcome;
      state.error = verdict.error;
      state.finishedAt = Date.now();
      emit({
        type: "step.finished",
        stepId: state.step.id,
        tool: state.step.tool,
        status: state.status,
        evidence: state.status === "succeeded" ? result.outcome.evidence : undefined,
        error: state.error,
        durationMs: result.durationMs,
      });
    }
    return toolCalls;
  }
}

/** Deterministic, evidence-only response text. Never states more than the steps showed. */
export function composeResponse(
  outcome: RunOutcome,
  plan: Plan | null,
  steps: StepState[],
  verification: VerificationReport | null,
  error?: string,
): string {
  if (outcome === "refused") {
    if (plan?.clarification) return plan.clarification;
    return `I can't do that with the tools I currently have. ${plan?.refusalReason ?? ""}`.trim();
  }
  const ok = steps.filter((s) => s.status === "succeeded");
  const header: Record<Exclude<RunOutcome, "refused">, string> = {
    completed: "Done.",
    unverified: "All steps ran, but I couldn't confirm the result fully answers your request.",
    partial: `Partially done: ${ok.length} of ${steps.length} step${steps.length === 1 ? "" : "s"} succeeded.`,
    failed: "I couldn't complete this.",
    cancelled: `Cancelled after ${ok.length} of ${steps.length} step${steps.length === 1 ? "" : "s"}.`,
  };
  const lines: string[] = [header[outcome]];
  for (const s of steps) {
    if (s.status === "succeeded") lines.push(`• ${s.outcome?.evidence}`);
    else if (s.status === "failed") lines.push(`• ${s.step.description}: failed (${s.error})`);
    else if (s.status === "skipped") lines.push(`• ${s.step.description}: not run (${s.error})`);
  }
  // What the deterministic checks DID establish, kept apart from what they could not (e.g. a summary). Stated only
  // when every step succeeded and was grounded and every detected request part was shown by a tool result.
  const extractionVerified = outcome === "unverified" && !!verification
    && steps.length > 0 && steps.every((s) => s.status === "succeeded")
    && verification.facets.length > 0 && verification.facets.every((f) => f.satisfied)
    && verification.grounding.length > 0 && verification.grounding.every((g) => g.status === "grounded");
  if (extractionVerified) {
    lines.push(`Verified: ${verification!.facets.map((f) => f.description).join("; ")} (checked against the source by the tools).`);
  }
  if (outcome !== "completed" && verification?.missing.length) {
    lines.push(`Not confirmed: ${verification.missing.join("; ")}`);
  } else if (outcome === "unverified" && verification && !verification.independentlyVerified) {
    lines.push("Not independently confirmed: no deterministic check covers every part of this request.");
  }
  if (extractionVerified && verification!.unexplained.some((w) => /^(summar|sum$|gist|tldr|tl;dr|key$|main$|points$)/i.test(w))) {
    lines.push("Not verified: the summary. No check can confirm a summary, so none is given; the text above is the file's own content.");
  }
  if (error) lines.push(error);
  return lines.join("\n");
}
