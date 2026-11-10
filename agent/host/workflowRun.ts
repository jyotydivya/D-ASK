// "Run the workflow X": the host reads the workflow's steps from the daemon (workflows.get, read-only) and runs each step
// as an ordinary request through the same AgentRuntime: same planning, grounding, approvals and fail-closed outcome.
// Steps run strictly in order; the first step that fails, is refused, cancelled or only partly done stops the workflow
// (later steps are reported as not run). The workflow is "completed" only if every step was completed.

import type { AgentRuntime } from "../runtime/runtime";
import type { DesktopBridge } from "../runtime/tools/desktop";
import type { RunOutcome, RuntimeEvent } from "../runtime/types";
import { toTaskResult, type TaskResult } from "./host";   // used at call time only (host imports this module)

const STOPS: ReadonlySet<RunOutcome> = new Set(["failed", "refused", "cancelled", "partial"]);

export async function runWorkflow(name: string, deps: { runtime: Pick<AgentRuntime, "run">; desktop?: DesktopBridge }, taskId: string, signal: AbortSignal,
  emit: (e: RuntimeEvent) => void): Promise<TaskResult> {
  const done = (outcome: RunOutcome, response: string, extra: Partial<TaskResult> = {}): TaskResult =>
    ({ taskId, outcome, response, iterations: 0, toolCalls: 0, error: null, steps: [], verification: null, ...extra });
  const bridge = deps.desktop;
  if (!bridge?.available || (bridge.offers && !bridge.offers("workflows.get"))) return done("refused", "Workflows are not enabled (AgentHost:Workflows).");
  let reply;
  try { reply = await bridge.call(taskId, "workflows.get", { name }, signal, 6_000); } catch (e) { return done("failed", `Could not read the workflow: ${e instanceof Error ? e.message : String(e)}`); }
  if (reply.status !== "ok") return done(reply.status === "cancelled" ? "cancelled" : "refused", reply.error?.message ?? "Could not read the workflow.");
  const steps = (reply.result?.steps ?? []) as string[];
  const wfName = String(reply.result?.name ?? name);
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((s) => typeof s !== "string")) return done("failed", "The workflow has no valid steps.");

  const results: TaskResult[] = [];
  let stoppedAt = -1;
  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) { stoppedAt = i; break; }
    const report = await deps.runtime.run({ taskId, objective: steps[i]!, signal, sink: { emit } });
    const r = toTaskResult(report);
    results.push(r);
    if (STOPS.has(r.outcome)) { stoppedAt = i + 1; break; }
  }
  const outcomes = results.map((r) => r.outcome);
  const outcome: RunOutcome = signal.aborted ? "cancelled"
    : stoppedAt > 0 ? (outcomes.at(-1) === "refused" || outcomes.at(-1) === "failed") && results.length === 1 ? outcomes.at(-1)! : "partial"
    : outcomes.every((o) => o === "completed") ? "completed" : "unverified";
  const lines = [`Workflow "${wfName}": ${results.filter((r) => r.outcome === "completed").length} of ${steps.length} step(s) completed.`];
  steps.forEach((s, i) => {
    const r = results[i];
    lines.push(r ? `${i + 1}. ${s}: ${r.outcome}\n   ${r.response.split("\n").join("\n   ")}` : `${i + 1}. ${s}: not run (an earlier step did not complete)`);
  });
  return done(outcome, lines.join("\n"), {
    iterations: results.reduce((a, r) => a + r.iterations, 0), toolCalls: results.reduce((a, r) => a + r.toolCalls, 0),
    steps: results.flatMap((r, i) => r.steps.map((s: TaskResult["steps"][number]) => ({ ...s, id: `w${i + 1}_${s.id}` }))),
  });
}
