// Workflow management requests (save / list / delete / schedule / unschedule) routed by the host WITHOUT the model planner,
// the same way "Run the workflow X" is (workflowRun.ts). Acceptance evidence showed a trivially valid request
// ("Unschedule the workflow dropme") refused by the local planner before any tool call; these requests are fully
// determined by their text, so the model adds nothing but a way to fail.
//
// What this does NOT change: the tools themselves (workflows.ts) read the steps and the timing from the request text and the
// daemon validates, stores and approves exactly as before (Workflow.Schedule still shows an approval card; save, list, delete
// and unschedule still touch only D-ASK's own store and still need none). The host only replaces "ask the model for a plan"
// with "the plan is the one call the request states". Anything not an explicit, unambiguous management request is not
// claimed (it goes to the runtime as before); a claimed but malformed request is refused with a usage hint, never guessed.

import type { DesktopBridge } from "../runtime/tools/desktop";
import type { RunOutcome, RuntimeEvent, ToolOutcome, VerificationReport } from "../runtime/types";
import {
  createWorkflowTools, deletedWorkflow, savedWorkflow, scheduledWorkflow, unscheduledWorkflow,
} from "../runtime/tools/workflows";
import type { TaskResult } from "./host";

export type ManageOp = "save" | "list" | "delete" | "schedule" | "unschedule";
export type ManageParse =
  | { kind: "none" }
  | { kind: "refuse"; reason: string; soft?: boolean }   // soft: the exact grammar could not read it; the natural-language path may still understand it
  | { kind: "route"; op: ManageOp; name: string | null };

/**
 * Progress events for a routed request, in the SAME protocol the runtime uses (plan -> step.started -> [approval.denied] -> step.finished -> [verification]),
 * so the HUD's existing status panel renders its RESULT panel. They only describe what really happened; they carry no verdict of their own.
 */
export type Emit = (e: RuntimeEvent) => void;
const safeEmit = (emit: Emit | undefined, e: RuntimeEvent) => { try { emit?.(e); } catch { /* progress never affects a task */ } };
const stepTool = (op: ManageOp) => `workflow.${op}`;
export function emitPlanned(emit: Emit | undefined, op: ManageOp, goal: string): void {
  safeEmit(emit, { type: "plan", iteration: 1, plan: { intent: "task", goal, successCriteria: [], steps: [{ id: "m1", tool: stepTool(op), description: goal, input: {}, dependsOn: [] }] } });
  safeEmit(emit, { type: "step.started", stepId: "m1", tool: stepTool(op), description: goal, input: {} });
}
export function emitStepFinished(emit: Emit | undefined, op: ManageOp, status: "succeeded" | "failed" | "cancelled", ms: number, denied = false): void {
  if (denied) safeEmit(emit, { type: "approval.denied", stepId: "m1", tool: stepTool(op), reason: "not approved" });
  safeEmit(emit, { type: "step.finished", stepId: "m1", tool: stepTool(op), status, durationMs: ms });
}
/** Only for a REAL deterministic check (the exact path's request check). Never emitted for model-interpreted requests. */
function emitVerified(emit: Emit | undefined, facets: { id: string; description: string; satisfied: boolean }[], satisfied: boolean): void {
  const report: VerificationReport = { stepsSucceeded: 1, stepsTotal: 1, criteriaSatisfied: satisfied, needsMoreSteps: false, missing: [], method: "evidence-only", notes: [],
    grounding: [{ stepId: "m1", tool: "workflow", status: "grounded", reason: "the call is the one the request states" }], facets, unexplained: [], independentlyVerified: satisfied };
  safeEmit(emit, { type: "verification", report });
}
/** A refused or clarified request: the same plan shape the runtime emits for a refusal (no steps), so the panel shows the outcome accurately. */
export function announceRefusal(emit: Emit | undefined, text: string): void {
  safeEmit(emit, { type: "plan", iteration: 1, plan: { intent: "unsupported", goal: text.slice(0, 200), refusalReason: text, clarification: text, successCriteria: [], steps: [] } });
}

const DAEMON_TOOL: Record<ManageOp, string> = { save: "workflows.save", list: "workflows.list", delete: "workflows.delete", schedule: "workflows.schedule", unschedule: "workflows.unschedule" };

// A request is a management request only if it STARTS with a management verb about "workflow(s)".
const SAVE_V = String.raw`(?:save|create|make|define|add)`;
const DELETE_V = String.raw`(?:delete|remove|forget)`;
const UNSCHED_V = String.raw`(?:unschedule|stop\s+scheduling|stop\s+running|cancel\s+the\s+schedule\s+(?:of|for))`;
const LIST_V = String.raw`(?:list|show)`;
const FILL = String.raw`(?:\s+(?:a|an|the|my|new|all|me|saved)){0,3}`;
const head = (verbs: string) => new RegExp(String.raw`^\s*(?:please\s+)?${verbs}\b${FILL}\s+(?:called\s+|named\s+)?workflows?\b`, "i");
const SAVE_HEAD = head(SAVE_V), DELETE_HEAD = head(DELETE_V), UNSCHED_HEAD = head(UNSCHED_V), LIST_HEAD = head(LIST_V), SCHEDULE_HEAD = head(String.raw`schedule`);
const RUN_HEAD = head(String.raw`(?:run|start|execute)`);   // "run the workflow X every day at 9" is a schedule; a plain run is workflowRun.ts
const LIST_FULL = /^\s*(?:please\s+)?(?:(?:list|show)(?:\s+me)?(?:\s+(?:all|my|the|saved))*\s+workflows|what\s+workflows\s+(?:do\s+i\s+have|are\s+(?:saved|there)))\s*[.!?]?\s*$/i;
const TIMING = /\b(?:every\s+(?:day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|on\s+\d{4}-\d{2}-\d{2})\b/i;
const SINGLE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

const USAGE: Record<ManageOp, string> = {
  save: 'Say it as: Save a workflow called NAME: first step; then second step (1 to 8 steps; put a name with spaces in quotes).',
  list: 'Say it as: List my workflows.',
  delete: 'Say it as: Delete the workflow NAME (put a name with spaces in quotes).',
  schedule: 'Say it as: Schedule the workflow NAME every day at 09:00 (or every Monday at 8:30 pm, or on 2026-12-01 at 10:00).',
  unschedule: 'Say it as: Unschedule the workflow NAME (put a name with spaces in quotes).',
};

/** A name is unambiguous if it is one word or the request quotes it: an unquoted multi-word name could swallow trailing words. */
function nameIsExplicit(objective: string, name: string): boolean {
  if (SINGLE_TOKEN.test(name)) return true;
  const q = (a: string, b: string) => objective.includes(a + name + b);
  return q('"', '"') || q("“", "”") || q("'", "'");
}

export function parseManageRequest(objective: string, known: readonly { name: string }[] = []): ManageParse {
  const o = objective.trim();
  const refuse = (op: ManageOp, why: string, soft = false): ManageParse => ({ kind: "refuse", reason: `${why} ${USAGE[op]}`, soft });
  const route = (op: ManageOp, name: string | null, needsName = true): ManageParse =>
    !needsName ? { kind: "route", op, name: null }
    : name === null ? refuse(op, "I couldn't tell which workflow you mean.", true)
    : !nameIsExplicit(o, name) && !known.some((k) => k.name.toLowerCase() === name.toLowerCase()) ? refuse(op, `The workflow name "${name}" is ambiguous without quotes.`)
    : { kind: "route", op, name };

  if (SCHEDULE_HEAD.test(o)) return route("schedule", scheduledWorkflow(o)?.name ?? null);
  if (RUN_HEAD.test(o)) {
    const s = scheduledWorkflow(o);
    if (s) return route("schedule", s.name);
    // Timing words make it a schedule request (a bad time is refused, not run); without them it is a plain run: not ours.
    return TIMING.test(o) ? refuse("schedule", "I couldn't read that schedule.") : { kind: "none" };
  }
  if (SAVE_HEAD.test(o)) return route("save", savedWorkflow(o)?.name ?? null);
  if (UNSCHED_HEAD.test(o)) return route("unschedule", unscheduledWorkflow(o));
  if (DELETE_HEAD.test(o)) return route("delete", deletedWorkflow(o));
  if (LIST_HEAD.test(o)) return LIST_FULL.test(o) ? route("list", null, false) : refuse("list", "I couldn't tell what you want to do with your workflows.");
  if (LIST_FULL.test(o)) return route("list", null, false);   // "What workflows do I have?"
  return { kind: "none" };
}

/** Runs one management request as exactly the one tool call it states (no planner). Same tool code, same daemon call, same checks. */
export async function manageWorkflow(op: ManageOp, name: string | null, objective: string, deps: { desktop?: DesktopBridge }, taskId: string, signal: AbortSignal, emit?: Emit): Promise<TaskResult> {
  const base = (outcome: RunOutcome, response: string, extra: Partial<TaskResult> = {}): TaskResult =>
    ({ taskId, outcome, response, iterations: 0, toolCalls: 0, error: null, steps: [], verification: null, ...extra });
  const bridge = deps.desktop;
  if (!bridge?.available || (bridge.offers && !bridge.offers(DAEMON_TOOL[op]))) { announceRefusal(emit, "Workflows are not enabled (AgentHost:Workflows)."); return base("refused", "Workflows are not enabled (AgentHost:Workflows)."); }
  const tool = createWorkflowTools(bridge).find((t) => t.name === `workflow.${op}`);
  if (!tool) return base("failed", "I couldn't complete this.", { error: "workflow tool missing" });
  const input = op === "list" ? {} : { name };
  let outcome: ToolOutcome<any>;
  const t0 = Date.now();
  emitPlanned(emit, op, `${op} workflow${name ? ` "${name}"` : "s"}`);
  try { outcome = await tool.execute(input, { signal, taskId, stepId: "m1", objective }); }
  catch (e) { outcome = { ok: false, error: e instanceof Error ? e.message : String(e), evidence: "" }; }
  const step = { id: "m1", tool: tool.name, status: outcome.ok ? "succeeded" : "failed", evidence: outcome.ok ? outcome.evidence : null, error: outcome.ok ? null : outcome.error ?? "failed" };
  if (signal.aborted) { emitStepFinished(emit, op, "cancelled", Date.now() - t0); return base("cancelled", "Cancelled after 0 of 1 step.", { toolCalls: 1, steps: [{ ...step, status: "failed" }] }); }
  if (!outcome.ok) emitStepFinished(emit, op, "failed", Date.now() - t0, op === "schedule" && /not approved/i.test(String(outcome.error)));
  else emitStepFinished(emit, op, "succeeded", Date.now() - t0);
  if (!outcome.ok) return base("failed", `I couldn't complete this.\n• workflow ${op}: failed (${step.error})`, { toolCalls: 1, iterations: 1, error: step.error, steps: [step] });
  // The tool's own request check says whether its output shows what the request asked for (same rule the runtime verifier applies).
  const facets = tool.requestCheck?.facets(objective) ?? [];
  const satisfied = facets.length > 0 && facets.every((f) => tool.requestCheck!.satisfies(f, input, outcome));
  emitVerified(emit, facets.map((f) => ({ id: f.id, description: f.description, satisfied: tool.requestCheck!.satisfies(f, input, outcome) })), satisfied);
  return base(satisfied ? "completed" : "unverified", `${satisfied ? "Done." : "The step ran, but I couldn't confirm the result fully answers your request."}\n• ${outcome.evidence}`, {
    toolCalls: 1, iterations: 1, steps: [step],
    verification: { independentlyVerified: satisfied, criteriaSatisfied: satisfied, method: "deterministic request check (no model)", unexplained: [],
      facets: facets.map((f) => ({ id: f.id, satisfied: tool.requestCheck!.satisfies(f, input, outcome) })), grounding: [{ stepId: "m1", status: "grounded" }] },
  });
}

export function refusedManage(reason: string, taskId: string): TaskResult {
  return { taskId, outcome: "refused", response: reason, iterations: 0, toolCalls: 0, error: null, steps: [], verification: null };
}

// ── Natural-language requests: model interpretation, host validation, then the SAME daemon tools ─────────────────────
import type { LanguageModel } from "../runtime/types";
import { askModel, passesGate, validateIntent, type KnownWorkflow } from "./workflowIntent";

/** The user's saved workflows, read from the daemon (read-only, unmetered). null: workflows are not available at all. */
export async function fetchKnown(bridge: DesktopBridge | undefined, taskId: string, signal: AbortSignal): Promise<KnownWorkflow[] | null> {
  if (!bridge?.available || (bridge.offers && !bridge.offers("workflows.list"))) return null;
  try {
    const r = await bridge.call(taskId, "workflows.list", {}, signal, 6_000);
    if (r.status !== "ok" || !Array.isArray(r.result?.workflows)) return null;
    return (r.result.workflows as { name: string; steps: number; schedule: string | null }[]).filter((w) => typeof w?.name === "string").map((w) => ({ name: w.name, steps: Number(w.steps) || 0, schedule: w.schedule ?? null }));
  } catch { return null; }
}

const DESCRIBE: Record<ManageOp, (a: any) => string> = {
  save: (a) => `save a new workflow "${a.name}" with ${a.steps.length} step(s)`,
  list: () => "list your saved workflows",
  delete: (a) => `delete the workflow "${a.name}" completely`,
  schedule: (a) => `schedule the workflow "${a.name}" ${a.kind === "daily" ? "every day" : a.kind === "weekly" ? `every ${a.day}` : `once on ${a.date}`} at ${a.time} (this will ask for your approval)`,
  unschedule: (a) => `stop the workflow "${a.name}" from running automatically (the workflow itself stays saved)`,
};

/** Executes a VALIDATED interpretation through the daemon's own workflow tools. The daemon still validates, asks for the schedule approval and stores. */
export async function runInterpreted(op: ManageOp, args: Record<string, unknown>, note: string | undefined, deps: { desktop?: DesktopBridge }, taskId: string, signal: AbortSignal, emit?: Emit): Promise<TaskResult> {
  const base = (outcome: RunOutcome, response: string, extra: Partial<TaskResult> = {}): TaskResult => ({ taskId, outcome, response, iterations: 1, toolCalls: 0, error: null, steps: [], verification: null, ...extra });
  const bridge = deps.desktop;
  const tool = DAEMON_TOOL[op];
  if (!bridge?.available || (bridge.offers && !bridge.offers(tool))) { announceRefusal(emit, "Workflows are not enabled (AgentHost:Workflows)."); return base("refused", "Workflows are not enabled (AgentHost:Workflows)."); }
  const understood = `I understood this as: ${DESCRIBE[op](args)}.`;
  let reply;
  const t0 = Date.now();
  emitPlanned(emit, op, understood.replace(/^I understood this as: /, "").replace(/\.$/, ""));
  try { reply = await bridge.call(taskId, tool, args, signal, op === "schedule" ? 80_000 : 10_000); }
  catch (e) { emitStepFinished(emit, op, signal.aborted ? "cancelled" : "failed", Date.now() - t0); return signal.aborted ? base("cancelled", "Cancelled.", { toolCalls: 1 }) : base("failed", `I couldn't complete this.\n• ${understood}\n• ${e instanceof Error ? e.message : String(e)}`, { toolCalls: 1, error: "daemon call failed" }); }
  const r: any = reply.result ?? {};
  const step = (ok: boolean, evidence: string | null, error: string | null) => [{ id: "m1", tool: `workflow.${op}`, status: ok ? "succeeded" : "failed", evidence, error }];
  if (reply.status === "cancelled") { emitStepFinished(emit, op, "cancelled", Date.now() - t0); return base("cancelled", "Cancelled.", { toolCalls: 1, steps: step(false, null, "cancelled") }); }
  if (reply.status !== "ok") { emitStepFinished(emit, op, "failed", Date.now() - t0, reply.error?.code === "approval_denied"); const msg = reply.error?.message ?? "Not done."; return base("failed", `I couldn't complete this.\n• ${understood}\n• ${msg}`, { toolCalls: 1, error: msg, steps: step(false, null, msg) }); }
  let ok = false; let evidence = "";
  switch (op) {
    case "save": ok = r.saved === true; evidence = `Saved the workflow "${r.name}" with ${(r.steps ?? []).length} step(s):\n${(r.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`; break;
    case "list": { const ws = (r.workflows ?? []) as { name: string; steps: number; schedule: string | null }[]; ok = Array.isArray(r.workflows); evidence = ws.length ? ws.map((w) => `${w.name}: ${w.steps} step(s)${w.schedule ? `, runs ${w.schedule}` : ", not scheduled"}`).join("\n") : "No workflows are saved."; break; }
    case "delete": ok = r.deleted === true; evidence = `Deleted the workflow "${r.name}"${r.hadSchedule ? " and its schedule" : ""}.`; break;
    case "unschedule": ok = r.unscheduled === true; evidence = `"${r.name}" will no longer run on a schedule. The workflow is still saved.`; break;
    case "schedule": ok = r.verified === true; evidence = `"${r.name}" will run ${r.when} (first run ${r.firstRun}), only while the HUD is connected; steps that change something still ask for approval.`; break;
  }
  emitStepFinished(emit, op, ok ? "succeeded" : "failed", Date.now() - t0);
  const text = `${ok ? "Done." : "The step ran, but the daemon's answer did not confirm it."}\n• ${understood}\n• ${evidence}${note ? `\n• ${note}` : ""}`;
  return base(ok ? "completed" : "unverified", text, {
    toolCalls: 1, steps: step(true, evidence, null),
    // No independent-verification claim: the daemon confirmed what was DONE; that it is what the user MEANT rests on the model's reading, which nothing here verifies.
    verification: null,
  });
}

/** null: not a workflow-management request (or no way to tell): the caller continues as before. Otherwise a finished result. */
export async function interpretWorkflowRequest(objective: string, known: readonly KnownWorkflow[], deps: { desktop?: DesktopBridge; model?: LanguageModel; trace?: (e: Record<string, unknown>) => void; emit?: Emit }, taskId: string, signal: AbortSignal): Promise<TaskResult | null> {
  if (!deps.model) { deps.trace?.({ stage: "interpreter", skipped: "no model configured" }); return null; }
  if (!passesGate(objective, known)) { deps.trace?.({ stage: "interpreter", skipped: "gate: no workflow-related wording and no saved name mentioned" }); return null; }
  const ans = await askModel(deps.model, objective, known, signal);
  if (signal.aborted) return { taskId, outcome: "cancelled", response: "Cancelled.", iterations: 0, toolCalls: 0, error: null, steps: [], verification: null };
  if ("error" in ans) {
    deps.trace?.({ stage: "interpreter", modelError: ans.error, decision: { kind: "clarify", reason: "model unavailable" } });
    // The model is unavailable (e.g. the memory guard). Fail safe, with the exact forms that need no model.
    const msg = 'I couldn\'t interpret that request because the local model is not available right now, so I did nothing. You can still say it exactly, for example: "Unschedule the workflow NAME", "Delete the workflow NAME", "Schedule the workflow NAME every day at 9:00", "Save a workflow called NAME: step one; then step two", or "List my workflows".';
    announceRefusal(deps.emit, msg);
    return refusedManage(msg, taskId);
  }
  const intent = validateIntent(ans.raw, objective, known);
  deps.trace?.({ stage: "interpreter", rawModel: ans.raw, decision: intent });
  if (intent.kind === "none") return null;
  if (intent.kind === "clarify") { announceRefusal(deps.emit, intent.question); return refusedManage(intent.question, taskId); }
  return runInterpreted(intent.op, intent.args, intent.note, deps, taskId, signal, deps.emit);
}
