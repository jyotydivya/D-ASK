/**
 * Deterministic host routing of workflow-management requests (save / list / delete / schedule / unschedule): the model planner is
 * never consulted. Acceptance evidence: "Unschedule the workflow dropme" was refused by the local planner before any tool call.
 * Driven through the real AgentHost with a runtime that FAILS THE TEST if it is called, and a fake daemon that mirrors the daemon's
 * contract (the daemon's own validation, approval and store are covered by tests/DAsk.Daemon.Tests/WorkflowTests.cs).
 * Run with: npx tsx tests/agent-runtime/workflow-routing.test.ts
 */
import { AgentHost } from "../../agent/host/host";
import { parseManageRequest } from "../../agent/host/workflowManage";
import type { DesktopReply } from "../../agent/runtime/tools/desktop";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mirrors the daemon contract the tools rely on: exact-name lookup, not_found, approval-gated schedule (the "card"). */
class FakeDaemon {
  available = true; tools = new Set(["workflows.save", "workflows.list", "workflows.get", "workflows.delete", "workflows.schedule", "workflows.unschedule"]);
  store = new Map<string, { name: string; steps: string[]; schedule: string | null }>();
  calls: { tool: string; args: any }[] = [];   // the request's own calls; the host's initial read-only list is not counted
  private seen = new Set<string>();
  cardShown = 0; approve = true; enabled = true;
  offers(t: string) { return this.enabled && this.tools.has(t); }
  attach() {} enable() {} failAll() {} onReply() {} offered() { return null; }
  async call(task: string, tool: string, args: any): Promise<DesktopReply> {
    if (tool === "workflows.list" && !this.seen.has(task)) this.seen.add(task);
    else { this.seen.add(task); this.calls.push({ tool, args: structuredClone(args) }); }
    const key = String(args.name ?? "").toLowerCase(); const w = this.store.get(key);
    const nf: DesktopReply = { status: "error", error: { code: "not_found", message: "There is no workflow with that name." } };
    switch (tool) {
      case "workflows.save": this.store.set(key, { name: args.name, steps: args.steps, schedule: null }); return { status: "ok", result: { saved: true, name: args.name, steps: args.steps } };
      case "workflows.list": return { status: "ok", result: { workflows: [...this.store.values()].map((x) => ({ name: x.name, steps: x.steps.length, schedule: x.schedule })) } };
      case "workflows.delete": if (!w) return nf; this.store.delete(key); return { status: "ok", result: { deleted: true, name: w.name, hadSchedule: w.schedule !== null } };
      case "workflows.unschedule": if (!w) return nf; if (!w.schedule) return { status: "error", error: { code: "not_scheduled", message: `"${w.name}" is not scheduled.` } }; w.schedule = null; return { status: "ok", result: { unscheduled: true, name: w.name } };
      case "workflows.schedule": {
        if (!w) return nf;
        this.cardShown++;   // the daemon's approval card
        if (!this.approve) return { status: "error", error: { code: "approval_denied", message: "The schedule was not approved. Nothing was scheduled." } };
        w.schedule = args.kind === "daily" ? `every day at ${args.time}` : `${args.kind} ${args.time}`;
        return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: true, name: w.name, when: w.schedule, firstRun: "2026-11-12 09:00" } };
      }
    }
    return { status: "error", error: { code: "unknown_tool", message: "x" } };
  }
}

let n = 0;
async function submit(daemon: FakeDaemon, objective: string, plannerCalls: { n: number }) {
  const out: any[] = [];
  const host = new AgentHost({
    writeLine: (l) => out.push(JSON.parse(l)), log: () => {}, token: "tok", exit: () => {}, desktop: daemon as any,
    runtime: { run: async () => { plannerCalls.n++; throw new Error("the planner must not be consulted"); } } as any,
  });
  host.handleLine(JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "tok", emergencyStopped: false, stopGeneration: 0 } }));
  host.handleLine(JSON.stringify({ v: 1, id: "q1", op: "submit", params: { taskId: `t${++n}`, objective } }));
  for (let i = 0; i < 50 && !out.some((x) => x.event === "task.finished"); i++) await tick();
  return out.find((x) => x.event === "task.finished")?.data as { outcome: string; response: string; toolCalls: number; verification: { independentlyVerified: boolean } | null } | undefined;
}

async function main() {
  console.log("\n[P] parsing (pure)");
  for (const nm of ["nightly", "dropme"]) {
    const sv = parseManageRequest(`Save a workflow called ${nm}: What is 2+3?; then What is 10*4?`);
    check(sv.kind === "route" && sv.op === "save" && sv.name === nm, `P1 save ${nm}`, sv);
    const ls = parseManageRequest("List my workflows");
    check(ls.kind === "route" && ls.op === "list" && ls.name === null, "P2 list");
    const de = parseManageRequest(`Delete the workflow ${nm}`);
    check(de.kind === "route" && de.op === "delete" && de.name === nm, `P3 delete ${nm}`, de);
    const sc = parseManageRequest(`Run the workflow ${nm} every day at 9am`);
    check(sc.kind === "route" && sc.op === "schedule" && sc.name === nm, `P4 schedule (run … every day) ${nm}`, sc);
    const sc2 = parseManageRequest(`Schedule the workflow ${nm} every Monday at 8:30 pm`);
    check(sc2.kind === "route" && sc2.op === "schedule" && sc2.name === nm, `P5 schedule (schedule … every Monday) ${nm}`, sc2);
    const un = parseManageRequest(`Unschedule the workflow ${nm}`);
    check(un.kind === "route" && un.op === "unschedule" && un.name === nm, `P6 unschedule ${nm}`, un);
  }
  check(["Show me my workflows", "show all workflows", "what workflows do I have?", "Please list the saved workflows."].every((q) => { const r = parseManageRequest(q); return r.kind === "route" && r.op === "list"; }), "P7 list phrasings");
  const q = parseManageRequest('Unschedule the workflow "morning check"');
  check(q.kind === "route" && q.name === "morning check", "P8 a quoted multi-word name is explicit", q);
  check(parseManageRequest("Delete the workflow Morning").kind === "route" && (parseManageRequest("Delete the workflow Morning") as any).name === "Morning", "P9 the name keeps the user's spelling (the daemon matches it)");

  console.log("\n[A] ambiguous, missing, malformed: refused with a usage hint, never guessed");
  for (const bad of [
    "Unschedule the workflow morning check", "Delete the workflow nightly and the file report.txt", "Delete the workflow", "Unschedule the workflow", "Unschedule workflows",
    "Save a workflow called nightly", "Save a workflow", "Save a workflow called nightly: ", "Schedule the workflow nightly", "Schedule the workflow nightly every day",
    "Schedule the workflow nightly every day at 25:00", "Run the workflow nightly every day at 13pm", "Show the workflow nightly", "List workflow things please",
    "Save a workflow called a: run the workflow b",
  ]) {
    const r = parseManageRequest(bad);
    check(r.kind === "refuse" && r.reason.length > 20, `A1 refused: ${bad}`, r);
  }
  console.log("\n[N] not claimed (goes to the runtime exactly as before)");
  for (const other of ["What time is it?", "Run the workflow nightly", "Summarize the notes about workflows", "Remind me to save a workflow called x: y", "Can you delete the workflow nightly?",
    "Organize the files in \"C:\\x\" by type", "Show me the weather", "How do workflows work?"]) {
    check(parseManageRequest(other).kind === "none", `N1 not claimed: ${other}`, parseManageRequest(other));
  }

  console.log("\n[H] through the real AgentHost: no planner, same daemon calls, same approval");
  for (const nm of ["nightly", "dropme"]) {
    const d = new FakeDaemon(); const pl = { n: 0 };
    let r = await submit(d, `Save a workflow called ${nm}: What is 2+3?; then What is 10*4?`, pl);
    check(r?.outcome === "completed" && JSON.stringify(d.calls[0]) === JSON.stringify({ tool: "workflows.save", args: { name: nm, steps: ["What is 2+3?", "What is 10*4?"] } }) && d.cardShown === 0, `H1 save ${nm}: completed; the daemon got exactly the request's steps; no card`, { r, calls: d.calls });
    r = await submit(d, "List my workflows", pl);
    check(r?.outcome === "completed" && new RegExp(`${nm}: 2 step\\(s\\)`).test(r.response), `H2 list ${nm}`, r);
    r = await submit(d, `Run the workflow ${nm} every day at 09:00`, pl);
    check(r?.outcome === "completed" && d.cardShown === 1 && d.store.get(nm)?.schedule === "every day at 09:00" && JSON.stringify(d.calls.at(-1)) === JSON.stringify({ tool: "workflows.schedule", args: { name: nm, kind: "daily", time: "09:00" } }),
      `H3 schedule ${nm}: the daemon's approval was consulted (card shown) and the schedule stored`, { r, calls: d.calls.at(-1), card: d.cardShown });
    r = await submit(d, `Unschedule the workflow ${nm}`, pl);
    check(r?.outcome === "completed" && d.store.get(nm)?.schedule === null && /will no longer run on a schedule/.test(r.response) && r.verification?.independentlyVerified === true, `H4 unschedule ${nm} (the case the planner refused): completed, verified`, r);
    r = await submit(d, `Delete the workflow ${nm}`, pl);
    check(r?.outcome === "completed" && !d.store.has(nm), `H5 delete ${nm}`, r);
    check(pl.n === 0, `H6 the planner was never consulted for ${nm}`, pl);
  }
  {
    const d = new FakeDaemon(); const pl = { n: 0 };
    await submit(d, "Save a workflow called nightly: What is 2+3?", pl);
    d.approve = false;
    const r = await submit(d, "Schedule the workflow nightly every Monday at 8:30", pl);
    check(r?.outcome !== "completed" && /not approved/.test(r?.response ?? "") && d.cardShown === 1 && d.store.get("nightly")?.schedule === null, "H7 schedule approval is still required: denied -> not completed, nothing stored, honestly reported", r);
    d.approve = true;
    check(d.calls.filter((c) => c.tool === "workflows.schedule").length === 1, "H8 the host makes no approval decision of its own: one daemon schedule call per request");
    let r2 = await submit(d, "Delete the workflow ghost", pl);
    check(r2?.outcome === "failed" && /no workflow with that name/.test(r2.response), "H9 delete of an unknown workflow: the daemon's refusal is reported, nothing guessed", r2);
    r2 = await submit(d, "Unschedule the workflow nightly", pl);
    check(r2?.outcome === "failed" && /not scheduled/.test(r2.response), "H10 unschedule of an unscheduled workflow: the daemon's refusal is reported", r2);
    const before = d.calls.length;
    r2 = await submit(d, "Unschedule the workflow morning check", pl);
    check(r2?.outcome === "refused" && d.calls.length === before && /quotes/.test(r2.response), "H11 an ambiguous name is refused without any daemon call", r2);
    d.enabled = false;
    r2 = await submit(d, "Unschedule the workflow nightly", pl);
    check(r2?.outcome === "refused" && /not enabled/.test(r2.response) && d.calls.length === before, "H12 workflows not offered by the daemon -> refused, no call", r2);
    check(pl.n === 0, "H13 the planner was never consulted in any of these");
  }
  {
    // A request the host does not claim still reaches the runtime unchanged.
    const d = new FakeDaemon(); const pl = { n: 0 };
    const r = await submit(d, "What time is it?", pl);
    check(pl.n === 1 && r?.outcome === "failed", "H14 an ordinary request still goes to the runtime");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
