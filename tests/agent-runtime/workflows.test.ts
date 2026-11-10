/**
 * Workflows, agent side: grammar, tools through the real AgentRuntime with a scripted model and a fake daemon store,
 * and the host's "Run the workflow X" expansion (each step an ordinary, verified run). The daemon store, approval and
 * scheduler are covered by tests/DAsk.Daemon.Tests/WorkflowTests.cs.
 * Run with: npx tsx tests/agent-runtime/workflows.test.ts
 */
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { groundCall } from "../../agent/runtime/grounding";
import { deletedWorkflow, isListWorkflows, runWorkflowName, savedWorkflow, scheduledWorkflow, splitSteps, unscheduledWorkflow } from "../../agent/runtime/tools/workflows";
import { runWorkflow } from "../../agent/host/workflowRun";
import { parseRequest } from "../../agent/host/protocol";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? (this.plans.length > 1 ? this.plans.shift() : this.plans[0]) : SAT); }
}
const plan = (tool: string, input: Record<string, unknown>) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: [{ id: "s1", description: tool, tool, input, dependsOn: [] }] });

class FakeDaemon implements DesktopBridge {
  available = true; deny = false;
  store = new Map<string, { name: string; steps: string[]; schedule: string | null }>();
  calls: { tool: string; args: any }[] = [];
  offers(t: string) { return t.startsWith("workflows."); }
  async call(_t: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push({ tool, args: structuredClone(args) });
    const a = args as any; const key = String(a.name ?? "").toLowerCase();
    switch (tool) {
      case "workflows.save": this.store.set(key, { name: a.name, steps: a.steps, schedule: null }); return { status: "ok", result: { saved: true, name: a.name, steps: a.steps } };
      case "workflows.list": return { status: "ok", result: { workflows: [...this.store.values()].map((w) => ({ name: w.name, steps: w.steps.length, schedule: w.schedule })) } };
      case "workflows.get": { const w = this.store.get(key); return w ? { status: "ok", result: { name: w.name, steps: w.steps } } : { status: "error", error: { code: "not_found", message: "There is no workflow with that name." } }; }
      case "workflows.delete": return this.store.delete(key) ? { status: "ok", result: { deleted: true, name: a.name } } : { status: "error", error: { code: "not_found", message: "no" } };
      case "workflows.unschedule": { const w = this.store.get(key)!; w.schedule = null; return { status: "ok", result: { unscheduled: true, name: w.name } }; }
      case "workflows.schedule": {
        if (this.deny) return { status: "error", error: { code: "approval_denied", message: "The schedule was not approved. Nothing was scheduled." } };
        const w = this.store.get(key)!; w.schedule = a.kind === "daily" ? `every day at ${a.time}` : a.kind === "weekly" ? `every ${a.day} at ${a.time}` : `once, on ${a.date} at ${a.time}`;
        return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: true, name: w.name, when: w.schedule, firstRun: "2026-11-11 09:00" } };
      }
    }
    return { status: "error", error: { code: "unknown_tool", message: "x" } };
  }
}

async function main() {
  console.log("\n[G] grammar");
  const SAVE = 'Save a workflow called "morning": summarize docs/notes.md; then what time is it?';
  check(JSON.stringify(savedWorkflow(SAVE)) === JSON.stringify({ name: "morning", steps: ["summarize docs/notes.md", "what time is it?"] }), "G1 name and steps in the user's own words", savedWorkflow(SAVE));
  check(JSON.stringify(splitSteps('type "a; then b" into the notes field of the window titled "X"; then press Enter')) === JSON.stringify(['type "a; then b" into the notes field of the window titled "X"', "press Enter"]), "G2 separators inside quotes are text");
  check(splitSteps("run the workflow other") === null && splitSteps(Array(9).fill("what time is it").join("; ")) === null, "G3 no recursion; at most 8 steps");
  check(JSON.stringify(scheduledWorkflow("Run the workflow morning every day at 9am")) === JSON.stringify({ name: "morning", timing: { kind: "daily", time: "09:00" } })
    && scheduledWorkflow("Schedule the workflow morning every Monday at 8:30 pm")?.timing.day === "monday" && scheduledWorkflow("Schedule the workflow morning every Monday at 8:30 pm")?.timing.time === "20:30"
    && scheduledWorkflow("Schedule workflow morning on 2026-11-12 at 10:00")?.timing.kind === "once", "G4 daily / weekly (12-hour) / one-off timing");
  check(scheduledWorkflow("Run the workflow morning every day at 13pm") === null && scheduledWorkflow("Run the workflow morning") === null, "G5 impossible times and missing timing are not schedules");
  check(runWorkflowName('Run the workflow "morning"') === "morning" && runWorkflowName("Run the workflow morning every day at 9") === null, "G6 'run the workflow X' (now) vs a schedule");
  {
    const { clarificationFor, detectFacets } = await import("../../agent/runtime/grounding");
    const reg = createDefaultRegistry(process.cwd(), { desktop: new FakeDaemon() });
    const o = "Save a workflow called weekly: summarize the report; then close the window titled \"Notes\"";
    check(clarificationFor(reg, o) === null && detectFacets(reg, o).every((f) => f.tool === "workflow.save"),
      "G8 a save claims its request: steps are stored text (no 'which report?', no actuation refusal, no other facets)", { q: clarificationFor(reg, o), f: detectFacets(reg, o).map((f) => f.id) });
  }
  check(deletedWorkflow("Delete the workflow morning") === "morning" && unscheduledWorkflow("Unschedule the workflow morning") === "morning" && isListWorkflows("List my workflows"), "G7 delete / unschedule / list");

  console.log("\n[T] tools through the runtime (fake daemon store)");
  const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
  const d = new FakeDaemon();
  const run = (model: LanguageModel, objective: string) => new AgentRuntime({ model, registry: createDefaultRegistry(process.cwd(), { desktop: d }), granted: GRANTS }).run({ taskId: `w${Math.random()}`.replace(".", ""), objective });
  {
    const r = await run(new Scripted([plan("workflow.save", { name: "morning" })]), SAVE);
    check(r.outcome === "completed" && JSON.stringify(d.calls[0]?.args) === JSON.stringify({ name: "morning", steps: ["summarize docs/notes.md", "what time is it?"] }),
      "T1 save: the daemon gets exactly the request's steps (the model supplied only the name)", { o: r.outcome, call: d.calls[0], r: r.response });
    const other = await run(new Scripted([plan("workflow.save", { name: "evening" })]), SAVE);
    check(other.outcome !== "completed" && d.calls.length === 1, "T2 a different name from the model never reaches the daemon");
    check(groundCall(createDefaultRegistry(process.cwd(), { desktop: d }), "workflow.save", { name: "morning" }, SAVE).status === "grounded", "T3 the save call is grounded in the request");
    const sch = await run(new Scripted([plan("workflow.schedule", { name: "morning" })]), "Run the workflow morning every day at 9am");
    check(sch.outcome === "completed" && JSON.stringify(d.calls.at(-1)?.args) === JSON.stringify({ name: "morning", kind: "daily", time: "09:00" }) && /only while the HUD is connected/.test(sch.response),
      "T4 schedule: timing parsed from the request, approved in the daemon; the conditions are stated", { o: sch.outcome, args: d.calls.at(-1)?.args });
    d.deny = true;
    const denied = await run(new Scripted([plan("workflow.schedule", { name: "morning" })]), "Schedule the workflow morning every Monday at 8:30");
    check(denied.outcome !== "completed" && /not approved/.test(denied.response), "T5 schedule denied -> not completed, honestly reported");
    d.deny = false;
    const list = await run(new Scripted([plan("workflow.list", {})]), "List my workflows");
    check(list.outcome === "completed" && /morning: 2 step\(s\), runs every day at 09:00/.test(list.response), "T6 list shows steps and schedule", list.response);
    const uns = await run(new Scripted([plan("workflow.unschedule", { name: "morning" })]), "Unschedule the workflow morning");
    check(uns.outcome === "completed" && d.store.get("morning")!.schedule === null, "T7 unschedule");
  }

  console.log("\n[R] 'Run the workflow X' expands into ordinary runs");
  {
    const store = new FakeDaemon();
    store.store.set("check", { name: "check", steps: ["What time is it?", "What is 2+3?"], schedule: null });
    store.store.set("broken", { name: "broken", steps: ["What is 2+3?", "Read docs/does-not-exist.md", "What time is it?"], schedule: null });
    const runtimeFor = (plans: unknown[]) => new AgentRuntime({ model: new Scripted(plans), registry: createDefaultRegistry(process.cwd(), { desktop: store }), granted: GRANTS });
    const ok = await runWorkflow("check", { runtime: runtimeFor([plan("system.time", {}), plan("math.evaluate", { expression: "2+3" })]), desktop: store }, "t1", new AbortController().signal, () => {});
    check(ok.outcome === "completed" && /2 of 2 step\(s\) completed/.test(ok.response) && /1\. What time is it\?: completed/.test(ok.response) && /= 5|\b5\b/.test(ok.response),
      "R1 both steps run in order, each verified; the workflow completes", { o: ok.outcome, r: ok.response });
    const stop = await runWorkflow("broken", { runtime: runtimeFor([plan("math.evaluate", { expression: "2+3" }), plan("filesystem.read", { path: "docs/does-not-exist.md" }), plan("system.time", {})]), desktop: store }, "t2", new AbortController().signal, () => {});
    check(stop.outcome === "partial" && /3\. What time is it\?: not run/.test(stop.response), "R2 a failing step stops the workflow; later steps are not run; partial", { o: stop.outcome, r: stop.response });
    const missing = await runWorkflow("nope", { runtime: runtimeFor([plan("system.time", {})]), desktop: store }, "t3", new AbortController().signal, () => {});
    check(missing.outcome === "refused" && /no workflow with that name/.test(missing.response), "R3 an unknown workflow is refused, nothing runs");
    const off = await runWorkflow("check", { runtime: runtimeFor([plan("system.time", {})]), desktop: undefined }, "t4", new AbortController().signal, () => {});
    check(off.outcome === "refused" && /not enabled/.test(off.response), "R4 without the daemon's workflows: refused");
  }

  console.log("\n[H] protocol");
  {
    const hello = (tools: string[]) => JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "t", emergencyStopped: false, stopGeneration: 0, desktop: { proto: 2, tools } } });
    const all = ["desktop.list_windows", "desktop.inspect_window", "desktop.click_element", "desktop.type_text", "desktop.press_keys", "desktop.focus_window", "desktop.set_window_state",
      "browser.request_action", "files.organize", "files.undo_organize", "workflows.save", "workflows.list", "workflows.get", "workflows.delete", "workflows.schedule", "workflows.unschedule"];
    let ok = false; try { ok = (parseRequest(hello(all)).params as any).desktop.tools.length === 16; } catch { ok = false; }
    check(ok, "H1 the daemon's full offer (16 tools) is accepted");
    let refused = false; try { parseRequest(hello(["workflows.run_now"])); } catch { refused = true; }
    check(refused, "H2 any other workflows.* name is refused");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
