// ─────────────────────────────────────────────────────────────────────────────
// Reusable workflows (agent side). The daemon owns the store and the clock (WorkflowService / WorkflowScheduler).
//
// The model supplies at most the workflow NAME, pinned to the request. The steps and the timing are read by the tool
// itself from the request text (ctx.objective), so a model can never change what is saved or when it runs. Scheduling is
// approved in the HUD (the card shows every step and the timing). Running a workflow ("Run the workflow X") is expanded
// by the agent host into its steps, each an ordinary, separately verified task (agent/host/workflowRun.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolRequestCheck, ToolSpec } from "../types";
import type { DesktopBridge, DesktopReply } from "./desktop";

export const MAX_STEPS = 8;
const NAME = String.raw`["“']?([\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}?)["”']?`;
const SAVE = new RegExp(String.raw`\b(?:save|create|make|define|add)\s+(?:a\s+|new\s+)*workflow\s+(?:called|named)\s+${NAME}\s*(?::|\bthat\s+(?:does|runs|will)\b|\bwith\s+(?:the\s+)?steps\b|\bwhich\s+(?:does|runs)\b|\bto\b)\s*(.+)$`, "iu");
const LIST = /\b(list|show|what\s+are|which)\b.*\bworkflows\b/i;
const DELETE = new RegExp(String.raw`\b(?:delete|remove|forget)\s+(?:the\s+|my\s+)?workflow\s+(?:called\s+|named\s+)?${NAME}\s*[.!]?\s*$`, "iu");
const UNSCHEDULE = new RegExp(String.raw`\b(?:unschedule|stop\s+scheduling|cancel\s+the\s+schedule\s+(?:of|for)|stop\s+running)\s+(?:the\s+|my\s+)?workflow\s+(?:called\s+|named\s+)?${NAME}(?:\s+(?:automatically|on\s+a\s+schedule))?\s*[.!]?\s*$`, "iu");
const SCHEDULE = new RegExp(String.raw`\b(?:schedule|run)\s+(?:the\s+|my\s+)?workflow\s+(?:called\s+|named\s+)?${NAME}\s+(every\s+day|daily|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:\d{4}-\d{2}-\d{2}))\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[.!]?\s*$`, "iu");
export const RUN = new RegExp(String.raw`^\s*(?:please\s+)?(?:run|start|execute)\s+(?:the\s+|my\s+)?workflow\s+(?:called\s+|named\s+)?${NAME}\s*(?:now)?\s*[.!]?\s*$`, "iu");

/** Steps in the user's own words: split on ";" or "then" outside quotes; trailing punctuation removed. Null if invalid. */
export function splitSteps(body: string): string[] | null {
  const masked = body.replace(/["“][^"”]*["”]/g, (m) => "\u0000".repeat(m.length));
  const parts: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(/\s*;\s*(?:and\s+)?(?:then\s+)?|\s*,?\s+(?:and\s+)?then\s+/gi)) { parts.push(body.slice(from, m.index!)); from = m.index! + m[0].length; }
  parts.push(body.slice(from));
  const steps = parts.map((s) => s.trim().replace(/[.;,]+$/, "").trim()).filter(Boolean);
  if (steps.length === 0 || steps.length > MAX_STEPS || steps.some((s) => s.length < 3 || s.length > 300)) return null;
  if (steps.some((s) => /\bworkflow\b|\bschedul/i.test(s))) return null;
  return steps;
}

export function savedWorkflow(o: string): { name: string; steps: string[] } | null {
  const m = SAVE.exec(o.trim());
  if (!m) return null;
  const steps = splitSteps(m[2]!);
  return steps ? { name: m[1]!.trim(), steps } : null;
}
export const deletedWorkflow = (o: string) => DELETE.exec(o.trim())?.[1]?.trim() ?? null;
export const unscheduledWorkflow = (o: string) => UNSCHEDULE.exec(o.trim())?.[1]?.trim() ?? null;
export const isListWorkflows = (o: string) => LIST.test(o) && !savedWorkflow(o);
export const runWorkflowName = (o: string) => (SCHEDULE.test(o.trim()) ? null : RUN.exec(o)?.[1]?.trim() ?? null);

export interface Timing { kind: "daily" | "weekly" | "once"; time: string; day?: string; date?: string }
export function scheduledWorkflow(o: string): { name: string; timing: Timing } | null {
  const m = SCHEDULE.exec(o.trim());
  if (!m) return null;
  let h = Number(m[3]); const min = Number(m[4] ?? "0"); const ampm = m[5]?.toLowerCase();
  if (ampm) { if (h < 1 || h > 12) return null; h = (h % 12) + (ampm === "pm" ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  const time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  const when = m[2]!.toLowerCase();
  const timing: Timing = /^(every\s+day|daily)$/.test(when) ? { kind: "daily", time }
    : when.startsWith("on ") ? { kind: "once", time, date: when.slice(3).trim() }
    : { kind: "weekly", time, day: when.replace(/^every\s+/, "") };
  return { name: m[1]!.trim(), timing };
}

// ── Checks ─────────────────────────────────────────────────────────────────────

const grounded = (r: string): GroundingVerdict => ({ status: "grounded", reason: r });
const ungrounded = (r: string): GroundingVerdict => ({ status: "ungrounded", reason: r });
const contradicted = (r: string): GroundingVerdict => ({ status: "contradicted", reason: r });
const same = (a?: string, b?: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const VOCAB = ["save", "create", "make", "define", "add", "a", "new", "workflow", "workflows", "called", "named", "that", "does", "runs", "will", "with",
  "the", "steps", "which", "to", "then", "and", "list", "show", "what", "are", "my", "which", "delete", "remove", "forget", "unschedule", "stop",
  "scheduling", "cancel", "schedule", "of", "for", "running", "automatically", "on", "run", "every", "day", "daily", "at", "am", "pm", "monday",
  "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "please"];

function nameCheck(tool: string, nameOf: (o: string) => string | null, describe: (n: string) => string, ok: (out: any) => boolean, contentWords = false): ToolRequestCheck<{ name?: string }, any> {
  return {
    argumentDomains: (o): Record<string, ArgumentDomain> => {
      const n = nameOf(o);
      return { name: n ? { kind: "enum", values: [n], optional: false } : { kind: "forbidden", reason: "the request names no workflow for this" } };
    },
    relevant: (o) => nameOf(o) !== null,
    // A workflow-management request is entirely about workflows: no other detector reacts to its words.
    claims: (o) => nameOf(o) !== null,
    facets: (o): RequestFacet[] => { const n = nameOf(o); return n ? [{ id: `${tool}:${n.toLowerCase()}`, tool, description: describe(n), data: n }] : []; },
    ground: (i, o) => { const n = nameOf(o); return !n ? ungrounded("not asked") : same(i.name, n) ? grounded("the workflow is the one named") : contradicted(`the request names "${n}"`); },
    satisfies: (f, i, outcome) => outcome.ok && same(i.name, f.data as string) && ok(outcome.output),
    // Every word of a step is the user's own content: accounted for by the tool that stores it verbatim.
    vocabulary: (o) => [...VOCAB, ...(nameOf(o) ?? "").toLowerCase().split(/\s+/), ...(contentWords ? o.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) : [])],
  };
}

// ── Tools ──────────────────────────────────────────────────────────────────────

const fail = (error: string) => ({ ok: false as const, error, evidence: "" });
async function call(bridge: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, timeoutMs = 10_000): Promise<DesktopReply | string> {
  if (!bridge.available || (bridge.offers && !bridge.offers(tool))) return "Workflows are not enabled (AgentHost:Workflows).";
  try { return await bridge.call(ctx.taskId, tool, args, ctx.signal, timeoutMs); } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const nameSchema = { type: "object" as const, properties: { name: { type: "string" as const, minLength: 1, maxLength: 40 } }, required: ["name"] };

export function createWorkflowTools(bridge: DesktopBridge): ToolSpec<any, any>[] {
  const save: ToolSpec<{ name: string }, any> = {
    name: "workflow.save",
    description: "Save a reusable workflow the user describes (\"Save a workflow called X: step one; then step two\"). Give only the name; the steps are taken from the request.",
    inputSchema: nameSchema, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 15_000,
    async execute(input, ctx) {
      const w = ctx.objective !== undefined ? savedWorkflow(ctx.objective) : null;
      if (!w || !same(input.name, w.name)) return fail("The request does not describe a workflow to save (name, then steps separated by \";\" or \"then\").");
      const r = await call(bridge, "workflows.save", { name: w.name, steps: w.steps }, ctx);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Not saved.");
      return { ok: true, output: r.result, evidence: `Saved the workflow "${w.name}" with ${w.steps.length} step(s):\n${w.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` };
    },
    // The steps are text to store, not requests to act on: this check claims the whole request (grounding.claimingTools).
    requestCheck: { ...nameCheck("workflow.save", (o) => savedWorkflow(o)?.name ?? null, (n) => `save the workflow ${n}`, (out) => out?.saved === true, true), claims: (o) => savedWorkflow(o) !== null },
  };
  const list: ToolSpec<Record<string, never>, any> = {
    name: "workflow.list",
    description: "List the user's saved workflows and their schedules.",
    inputSchema: { type: "object", properties: {} }, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
    async execute(_i, ctx) {
      const r = await call(bridge, "workflows.list", {}, ctx);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Could not list workflows.");
      const ws = (r.result?.workflows ?? []) as { name: string; steps: number; schedule: string | null; lastNote?: string | null }[];
      return { ok: true, output: r.result, evidence: ws.length ? ws.map((w) => `${w.name}: ${w.steps} step(s)${w.schedule ? `, runs ${w.schedule}` : ""}${w.lastNote ? ` (last: ${w.lastNote})` : ""}`).join("\n") : "No workflows are saved." };
    },
    requestCheck: {
      argumentDomains: () => ({}), relevant: isListWorkflows, claims: isListWorkflows,
      facets: (o) => (isListWorkflows(o) ? [{ id: "workflow.list", tool: "workflow.list", description: "list the saved workflows", data: null }] : []),
      ground: (_i, o) => (isListWorkflows(o) ? grounded("asked to list workflows") : ungrounded("not asked")),
      satisfies: (_f, _i, outcome) => outcome.ok && Array.isArray(outcome.output?.workflows), vocabulary: () => VOCAB,
    },
  };
  const del: ToolSpec<{ name: string }, any> = {
    name: "workflow.delete", description: "Delete one saved workflow the user names (and its schedule).",
    inputSchema: nameSchema, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
    async execute(input, ctx) {
      const r = await call(bridge, "workflows.delete", { name: input.name }, ctx);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Not deleted.");
      return { ok: true, output: r.result, evidence: `Deleted the workflow "${r.result?.name}"${r.result?.hadSchedule ? " and its schedule" : ""}.` };
    },
    requestCheck: nameCheck("workflow.delete", deletedWorkflow, (n) => `delete the workflow ${n}`, (out) => out?.deleted === true),
  };
  const unschedule: ToolSpec<{ name: string }, any> = {
    name: "workflow.unschedule", description: "Stop the schedule of one workflow the user names (the workflow stays saved).",
    inputSchema: nameSchema, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
    async execute(input, ctx) {
      const r = await call(bridge, "workflows.unschedule", { name: input.name }, ctx);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Not changed.");
      return { ok: true, output: r.result, evidence: `"${r.result?.name}" will no longer run on a schedule.` };
    },
    requestCheck: nameCheck("workflow.unschedule", unscheduledWorkflow, (n) => `unschedule the workflow ${n}`, (out) => out?.unscheduled === true),
  };
  const schedule: ToolSpec<{ name: string }, any> = {
    name: "workflow.schedule",
    description: "Ask the user (in the HUD) to approve running one saved workflow on a schedule they state (every day / every <weekday> / on <date> at <time>). Give only the name; the timing is taken from the request.",
    inputSchema: nameSchema, permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 90_000,
    async execute(input, ctx) {
      const s = ctx.objective !== undefined ? scheduledWorkflow(ctx.objective) : null;
      if (!s || !same(input.name, s.name)) return fail("The request does not state when to run the workflow.");
      const r = await call(bridge, "workflows.schedule", { name: s.name, ...s.timing }, ctx, 80_000);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Not scheduled.");
      return { ok: true, output: r.result, evidence: `"${r.result?.name}" will run ${r.result?.when} (first run ${r.result?.firstRun}), only while the HUD is connected; steps that change something still ask for approval.` };
    },
    requestCheck: { ...nameCheck("workflow.schedule", (o) => scheduledWorkflow(o)?.name ?? null, (n) => `schedule the workflow ${n}`, (out) => out?.verified === true, true), claims: (o) => scheduledWorkflow(o) !== null },
  };
  return [save, list, del, unschedule, schedule];
}
