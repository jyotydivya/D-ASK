// ─────────────────────────────────────────────────────────────────────────────
// ToolRegistry — the only way the runtime executes a tool.
//
// Every invocation goes through, in order:
//   1. lookup            (unknown tools are refused)
//   2. input validation  (schema; unknown properties refused)
//   3. permission check  (tool permissions ⊆ granted permissions)
//   4. approval gate     (requiresApproval tools; the default gate denies)
//   5. execution         (per-call timeout + caller cancellation via AbortSignal)
// New tools are added with register(); the core runtime never changes.
// ─────────────────────────────────────────────────────────────────────────────

import { validate } from "./schema";
import type {
  ApprovalGate,
  ToolDescriptor,
  ToolOutcome,
  ToolPermission,
  ToolSpec,
} from "./types";

export type InvokeStatus = "executed" | "unknown_tool" | "invalid_input" | "permission_denied" | "approval_denied" | "timeout" | "cancelled" | "error";

export interface InvokeResult {
  status: InvokeStatus;
  outcome: ToolOutcome;
  durationMs: number;
}

export interface InvokeOptions {
  taskId: string;
  stepId: string;
  signal: AbortSignal;
  granted: ReadonlySet<ToolPermission>;
  approvalGate: ApprovalGate;
  objective?: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const MAX_EVIDENCE = 2_000;

/** Fail-closed default: nothing that requires approval runs. */
export const DENY_ALL_APPROVALS: ApprovalGate = Object.freeze({
  async request() {
    return { approved: false, reason: "No approval channel is connected to the agent runtime; approval-required tools are refused." };
  },
});

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec<any, any>>();

  register<I, O>(spec: ToolSpec<I, O>): this {
    if (!TOOL_NAME.test(spec.name)) throw new Error(`Invalid tool name "${spec.name}" (expected namespace.action)`);
    if (this.tools.has(spec.name)) throw new Error(`Tool "${spec.name}" is already registered`);
    if (spec.inputSchema.type !== "object") throw new Error(`Tool "${spec.name}" input schema must be an object`);
    if (!(spec.timeoutMs > 0)) throw new Error(`Tool "${spec.name}" must declare a positive timeoutMs`);
    this.tools.set(spec.name, spec);
    return this;
  }

  /** Removes a tool (dynamic plugins: a revoked plugin's tools disappear before the next task). */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolSpec<any, any> | undefined {
    return this.tools.get(name);
  }

  /** Descriptors for discovery (planner prompt, UI). Never exposes execute(). */
  list(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      permissions: t.permissions,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
    }));
  }

  /** Tools the given permission set allows at all (used to keep plans within reach). */
  listUsable(granted: ReadonlySet<ToolPermission>): ToolDescriptor[] {
    return this.list().filter((t) => t.permissions.every((p) => granted.has(p)));
  }

  /** Every tool's per-task cleanup; failures are ignored (cleanup never changes a task's outcome). */
  async endTask(taskId: string): Promise<void> {
    await Promise.all([...this.tools.values()].map(async (t) => { try { await t.endTask?.(taskId); } catch { /* ignored */ } }));
  }

  validateInput(name: string, input: unknown): string[] {
    const spec = this.tools.get(name);
    if (!spec) return [`unknown tool "${name}"`];
    return validate(spec.inputSchema, input).errors;
  }

  async invoke(name: string, input: Record<string, unknown>, opts: InvokeOptions): Promise<InvokeResult> {
    const start = Date.now();
    const done = (status: InvokeStatus, outcome: ToolOutcome): InvokeResult => ({
      status,
      outcome: { ...outcome, evidence: truncate(outcome.evidence ?? "") },
      durationMs: Date.now() - start,
    });

    const spec = this.tools.get(name);
    if (!spec) return done("unknown_tool", { ok: false, error: `Unknown tool "${name}"`, evidence: "" });

    const errors = validate(spec.inputSchema, input).errors;
    if (errors.length > 0) return done("invalid_input", { ok: false, error: `Invalid input: ${errors.join("; ")}`, evidence: "" });

    const missing = spec.permissions.filter((p) => !opts.granted.has(p));
    if (missing.length > 0) {
      return done("permission_denied", { ok: false, error: `Permission denied: tool needs ${missing.join(", ")}`, evidence: "" });
    }

    if (opts.signal.aborted) return done("cancelled", { ok: false, error: "Cancelled before execution", evidence: "" });

    if (spec.requiresApproval) {
      let decision: { approved: boolean; reason: string };
      try {
        decision = await opts.approvalGate.request(
          { taskId: opts.taskId, stepId: opts.stepId, tool: name, input, risk: spec.risk },
          opts.signal,
        );
      } catch (err) {
        decision = { approved: false, reason: `Approval check failed: ${errMessage(err)}` };
      }
      if (decision.approved !== true) {
        return done("approval_denied", { ok: false, error: `Approval denied: ${decision.reason}`, evidence: "" });
      }
    }

    // Per-call controller: aborted by the caller's signal OR by the timeout.
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(opts.signal.reason);
    opts.signal.addEventListener("abort", onParentAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { controller.abort(new Error("timeout")); resolve("timeout"); }, spec.timeoutMs);
    });
    const cancelled = new Promise<"cancelled">((resolve) => {
      if (opts.signal.aborted) resolve("cancelled");
      opts.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });

    try {
      const raced = await Promise.race([
        spec.execute(input, { signal: controller.signal, taskId: opts.taskId, stepId: opts.stepId, ...(opts.objective !== undefined ? { objective: opts.objective } : {}) }),
        timedOut,
        cancelled,
      ]);
      if (raced === "timeout") return done("timeout", { ok: false, error: `Timed out after ${spec.timeoutMs} ms`, evidence: "" });
      if (raced === "cancelled") return done("cancelled", { ok: false, error: "Cancelled during execution", evidence: "" });
      if (!isOutcome(raced)) return done("error", { ok: false, error: "Tool returned a malformed result", evidence: "" });
      return done("executed", raced);
    } catch (err) {
      if (opts.signal.aborted) return done("cancelled", { ok: false, error: "Cancelled during execution", evidence: "" });
      return done("error", { ok: false, error: errMessage(err), evidence: "" });
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

function isOutcome(v: unknown): v is ToolOutcome {
  return typeof v === "object" && v !== null && typeof (v as ToolOutcome).ok === "boolean" && typeof (v as ToolOutcome).evidence === "string";
}

function truncate(s: string): string {
  return s.length > MAX_EVIDENCE ? s.slice(0, MAX_EVIDENCE) + " …[truncated]" : s;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
