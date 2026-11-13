// ─────────────────────────────────────────────────────────────────────────────
// Native HUD transport for agent tasks. In the desktop HUD a task goes through the Rust host and the
// daemon's named pipe; in a browser useTask keeps using HTTP. Nothing here decides an outcome: every
// result shown comes from the daemon, or says plainly that the connection to it was lost.
// The frontend sends an objective or a task id, nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskEvent, TaskEventType } from "../agent/types";

export interface NativeTaskResult {
  outcome: string;
  response: string;
  /** null when the daemon reported no verification (for example a refused or interrupted task). */
  independentlyVerified: boolean | null;
  interrupted: boolean;
  errorCode: string | null;
  /** The steps exactly as the daemon reported them. */
  steps: { id: string; status: string; detail: string | null }[];
}

export interface NativeAgentHandlers {
  onAccepted(taskId: string): void;
  onEvent(taskId: string, event: TaskEvent): void;
  onFinished(taskId: string | null, result: NativeTaskResult): void;
  onCancelling(taskId: string): void;
  onCancelFailed(taskId: string, message: string): void;
  /**
   * The final result of a task this HUD did NOT submit (a scheduled workflow run started by the daemon). Delivered only while the HUD is idle and only once
   * per task, so it can never disturb a task the user is running. Progress of such a task is not shown; its approval cards are (they have their own channel).
   */
  onExternalFinished?(taskId: string, result: NativeTaskResult): void;
  /**
   * Recovery after a HUD restart: the daemon's answer to recover(taskId). `result` is null when the daemon does not know the task (or it is not
   * finished). Never treated as a new task: it only fills in the history entry that recorded that task id.
   */
  onRecovered?(taskId: string, result: NativeTaskResult | null): void;
}

export interface NativeAgentDeps {
  post(message: unknown): void;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): Date;
}

/** Long enough for a first submit, which starts the host before the daemon replies. */
export const SUBMIT_REPLY_TIMEOUT_MS = 30_000;
export const MAX_OBJECTIVE_CHARS = 4000;
const MAX_EARLY_MESSAGES = 64;

export const CONNECTION_LOST_MESSAGE =
  "Lost the connection to the D-ASK daemon. The task's result is unknown and it was not retried. Steps it had already started may have taken effect.";

const REJECTION_MESSAGES: Record<string, string> = {
  agent_host_disabled: "The local agent is turned off in the daemon's settings.",
  host_unavailable: "The local agent could not be started.",
  emergency_stopped: "Emergency Stop is active. Resume before starting a task.",
  busy: "Another task is already running.",
  invalid_request: "That request can't be sent.",
  daemon_model_busy: "The daemon's own model is busy. Try again when it finishes.",
  daemon_unavailable: "The D-ASK daemon is not connected. Nothing was sent.",
};

export function rejectionMessage(code: string | null | undefined, fallback?: string | null): string {
  const known = code ? REJECTION_MESSAGES[code] : undefined;
  return known ?? fallback ?? "The request was refused.";
}

export function postToHud(message: unknown): void {
  const w = window as unknown as { ipc: { postMessage(json: string): void } };
  w.ipc.postMessage(JSON.stringify(message));
}

export function isNativeHud(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { ipc?: { postMessage?: unknown } };
  return typeof w.ipc?.postMessage === "function";
}

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Daemon progress → the event shapes the status panel already renders. Unknown kinds are dropped. */
export function progressToEvent(taskId: string, seq: number, raw: unknown, at: Date): TaskEvent | null {
  const d = asObject(raw);
  const make = (type: TaskEventType, payload: Json): TaskEvent => ({ id: `${taskId}:${seq}`, taskId, type, timestamp: at, payload });
  switch (d.type) {
    case "phase":
      return make("task.status_changed", { status: d.phase === "executing" ? "running" : d.phase });
    case "plan": {
      const tools = Array.isArray(d.tools) ? d.tools.map(String) : [];
      const ids = Array.isArray(d.stepIds) ? d.stepIds.map(String) : [];
      const steps = ids.map((id, i) => ({ id, tool: tools[i] ?? "", description: tools[i] ?? id }));
      return make("task.planned", { intent: d.intent, nodeCount: steps.length, steps, refusalReason: d.goal });
    }
    case "step.started":
      return make("node.started", { nodeId: d.stepId, name: d.tool });
    case "step.finished":
      return d.status === "succeeded"
        ? make("node.completed", { nodeId: d.stepId, name: d.tool })
        : make("node.failed", { nodeId: d.stepId, name: d.tool, status: d.status });
    case "approval.denied":
      return make("tool.failed", { tool: d.tool, error: "not approved" });
    case "verification":
      return make("verification.completed", { passed: d.independentlyVerified === true });
    default:
      return null;
  }
}

export function toNativeResult(raw: unknown): NativeTaskResult {
  const r = asObject(raw);
  const verification = asObject(r.verification);
  const steps: NativeTaskResult["steps"] = [];
  if (Array.isArray(r.steps)) {
    for (const s of r.steps) {
      const step = asObject(s);
      const id = asString(step.id);
      if (id) steps.push({ id, status: asString(step.status) ?? "failed", detail: asString(step.evidence) ?? asString(step.error) });
    }
  }
  return {
    // An unreadable result must not look like success.
    outcome: asString(r.outcome) ?? "failed",
    response: asString(r.response) ?? "",
    independentlyVerified: typeof verification.independentlyVerified === "boolean" ? verification.independentlyVerified : null,
    interrupted: r.interrupted === true,
    errorCode: asString(r.errorCode),
    steps,
  };
}

function localFailure(errorCode: string, response: string, interrupted: boolean, outcome = "failed"): NativeTaskResult {
  return { outcome, response, independentlyVerified: null, interrupted, errorCode, steps: [] };
}

/**
 * Correlates requests, responses and notifications for the one task the HUD can run at a time.
 * Progress can overtake the submit reply, so messages are held until the task id is known.
 */
export class NativeAgentClient {
  #submit: { requestId: string; timer: unknown } | null = null;
  #activeTaskId: string | null = null;
  #lastSeq = 0;
  #early: { type: string; payload: Json }[] = [];
  #cancelOnAccept = false;
  /** Task ids already finished or reported (a repeated notification must never create a second entry). */
  #reported = new Set<string>();

  constructor(private readonly deps: NativeAgentDeps, private readonly handlers: NativeAgentHandlers) {}

  get activeTaskId(): string | null { return this.#activeTaskId; }
  get isBusy(): boolean { return this.#submit !== null || this.#activeTaskId !== null; }

  submit(objective: string): void {
    const text = objective.trim();
    if (this.isBusy) {
      this.handlers.onFinished(null, localFailure("busy", rejectionMessage("busy"), false, "refused"));
      return;
    }
    if (!text || text.length > MAX_OBJECTIVE_CHARS) {
      this.handlers.onFinished(null, localFailure("invalid_request", `A request must be 1 to ${MAX_OBJECTIVE_CHARS} characters.`, false, "refused"));
      return;
    }
    const requestId = this.deps.newId();
    const timer = this.deps.setTimer(() => this.#submitTimedOut(requestId), SUBMIT_REPLY_TIMEOUT_MS);
    this.#submit = { requestId, timer };
    this.#early = [];
    this.#lastSeq = 0;
    this.#cancelOnAccept = false;
    this.deps.post({ type: "AgentTaskSubmit", payload: { request_id: requestId, objective: text } });
  }

  /** The panel keeps showing the task until the daemon reports how it actually ended. */
  cancel(): void {
    const taskId = this.#activeTaskId;
    if (!taskId) {
      // The daemon has not given the task an id yet: cancel as soon as it does.
      if (this.#submit) this.#cancelOnAccept = true;
      return;
    }
    this.deps.post({ type: "AgentTaskCancel", payload: { request_id: this.deps.newId(), task_id: taskId } });
  }

  /** Asks the daemon for the FINISHED result of a task this HUD submitted before it was closed (history recovery). Read-only. */
  recover(taskId: string): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return;
    this.deps.post({ type: "AgentTaskStatus", payload: { request_id: this.deps.newId(), task_id: taskId } });
  }

  handleMessage(message: unknown): void {
    const m = asObject(message);
    const type = asString(m.type);
    if (!type) return;
    const payload = asObject(m.payload);
    switch (type) {
      case "AgentTaskSubmitResponse": this.#onSubmitResponse(asString(m.replyToId), payload); break;
      case "AgentTaskCancelResponse": this.#onCancelResponse(payload); break;
      case "AgentTaskStatusResponse": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const result = payload.found === true && payload.state === "finished" && payload.result ? toNativeResult(asObject(payload.result)) : null;
        this.handlers.onRecovered?.(taskId, result);
        break;
      }
      case "AgentTaskProgressNotification":
      case "AgentTaskResultNotification": this.#onTaskMessage(type, payload); break;
      case "AgentConnection": if (payload.connected === false) this.#onDisconnected(); break;
    }
  }

  #clearSubmit(): void {
    if (this.#submit) this.deps.clearTimer(this.#submit.timer);
    this.#submit = null;
  }

  #submitTimedOut(requestId: string): void {
    if (this.#submit?.requestId !== requestId) return;
    this.#submit = null;
    this.#early = [];
    this.handlers.onFinished(null, localFailure("no_reply", "The daemon did not answer the request. It was not retried.", false));
  }

  #onSubmitResponse(replyToId: string | null, p: Json): void {
    const taskId = asString(p.taskId);
    if (!this.#submit || this.#submit.requestId !== replyToId) {
      // A late acceptance after the user was told it failed: do not leave a task running unseen.
      if (p.accepted === true && taskId && taskId !== this.#activeTaskId) {
        this.deps.post({ type: "AgentTaskCancel", payload: { request_id: this.deps.newId(), task_id: taskId } });
      }
      return;
    }
    this.#clearSubmit();
    if (p.accepted !== true || !taskId) {
      this.#early = [];
      const code = asString(p.rejectionCode) ?? "rejected";
      this.handlers.onFinished(null, localFailure(code, rejectionMessage(code, asString(p.errorMessage)), false, code === "emergency_stopped" || code === "busy" ? "refused" : "failed"));
      return;
    }
    this.#activeTaskId = taskId;
    this.handlers.onAccepted(taskId);
    const held = this.#early;
    this.#early = [];
    for (const h of held) this.#onTaskMessage(h.type, h.payload);
    if (this.#cancelOnAccept && this.#activeTaskId === taskId) this.cancel();
    this.#cancelOnAccept = false;
  }

  #onCancelResponse(p: Json): void {
    const taskId = asString(p.taskId);
    if (!taskId || taskId !== this.#activeTaskId) return;
    if (p.cancelling === true) this.handlers.onCancelling(taskId);
    // already_finished: the result notification is on its way and says how it ended.
    else if (p.rejectionCode !== "already_finished") this.handlers.onCancelFailed(taskId, "The task could not be cancelled. Use Emergency Stop if it must stop now.");
  }

  #onTaskMessage(type: string, p: Json): void {
    const taskId = asString(p.taskId);
    if (!taskId) return;
    if (taskId !== this.#activeTaskId) {
      // Only a pending submit can explain a task id we do not know yet. Anything else is not ours.
      if (this.#submit) { if (this.#early.length < MAX_EARLY_MESSAGES) this.#early.push({ type, payload: p }); return; }
      // Idle HUD and a FINAL result for a task we never submitted: a scheduled run. Report it once.
      if (this.#activeTaskId === null && type !== "AgentTaskProgressNotification" && !this.#reported.has(taskId)) {
        this.#reported.add(taskId);
        if (this.#reported.size > 200) this.#reported.delete(this.#reported.values().next().value as string);
        this.handlers.onExternalFinished?.(taskId, toNativeResult(p));
      }
      return;
    }
    if (type === "AgentTaskProgressNotification") {
      const seq = typeof p.seq === "number" ? p.seq : 0;
      if (seq <= this.#lastSeq) return;
      this.#lastSeq = seq;
      const event = progressToEvent(taskId, seq, p.data, this.deps.now());
      if (event) this.handlers.onEvent(taskId, event);
      return;
    }
    this.#activeTaskId = null;
    this.#reported.add(taskId);
    this.handlers.onFinished(taskId, toNativeResult(p));
  }

  /** The daemon cancels a session's tasks when it ends, and the outcome can never reach this session. */
  #onDisconnected(): void {
    if (this.#submit) {
      this.#clearSubmit();
      this.#early = [];
      this.handlers.onFinished(null, localFailure("daemon_connection_lost", CONNECTION_LOST_MESSAGE, true));
    }
    const taskId = this.#activeTaskId;
    if (taskId) {
      this.#activeTaskId = null;
      this.handlers.onFinished(taskId, localFailure("daemon_connection_lost", CONNECTION_LOST_MESSAGE, true));
    }
  }
}
