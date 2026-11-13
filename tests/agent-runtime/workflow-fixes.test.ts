/**
 * Fixes from the first real-HUD natural-language acceptance run (results/nl-hud/live-20261111T030014), through the real AgentHost:
 *   F1  a NEW workflow's name must be introduced by the user (N21: "Make a routine that tells me the time." must not create a workflow named "time")
 *   F3  a saved workflow named "time" must not capture ordinary time questions
 *   F2  routed requests emit the runtime's own progress events so the HUD's status panel renders its RESULT panel, truthfully
 * Run with: npx tsx tests/agent-runtime/workflow-fixes.test.ts
 */
import { AgentHost } from "../../agent/host/host";
import { explicitlyNamed, validateIntent } from "../../agent/host/workflowIntent";
import { progressToEvent, toNativeResult } from "../../hooks/nativeAgent";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";
import { FakeWorkflowDaemon } from "./fixtures/fakeWorkflowDaemon";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 800)}` : ""}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const WORLD = [
  { name: "nightly", steps: ["What is 2+3?"], schedule: "daily 21:00" },
  { name: "dropme", steps: ["What is 7+8?"], schedule: null },
  { name: "backup", steps: ["What is 1+1?"], schedule: "daily 02:00" },
];
/** The pure validator takes step COUNTS; the fake daemon world keeps the step texts. */
const known = (w: readonly { name: string; steps: readonly string[]; schedule: string | null }[]) => w.map((x) => ({ name: x.name, steps: x.steps.length, schedule: x.schedule }));

const raw = (operation: string, workflow_name = "", steps: string[] = [], ask = "") => ({ operation, workflow_name, steps, ask });
class Scripted implements LanguageModel {
  readonly name = "scripted"; calls = 0;
  constructor(private out: unknown | Error) {}
  async generateJson(_req: StructuredRequest) { this.calls++; if (this.out instanceof Error) throw this.out; return structuredClone(this.out); }
}
let n = 0;
async function ask(objective: string, model: LanguageModel | undefined, daemon = new FakeWorkflowDaemon(WORLD)) {
  const planner = { n: 0 }; const out: any[] = [];
  const host = new AgentHost({ writeLine: (l) => out.push(JSON.parse(l)), log: () => {}, token: "tok", exit: () => {}, desktop: daemon as any, model,
    runtime: { run: async (o: any) => { planner.n++; return { taskId: o.taskId, outcome: "completed", plan: null, steps: [], verification: null, response: "(runtime answered)", iterations: 1, toolCalls: 0 }; } } as any });
  host.handleLine(JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "tok", emergencyStopped: false, stopGeneration: 0 } }));
  host.handleLine(JSON.stringify({ v: 1, id: "q1", op: "submit", params: { taskId: `t${++n}`, objective } }));
  for (let i = 0; i < 200 && !out.some((x) => x.event === "task.finished"); i++) await tick();
  const finIdx = out.findIndex((x) => x.event === "task.finished");
  const fin = out[finIdx]?.data as { outcome: string; response: string; steps: any[]; verification: any } | undefined;
  const progress = out.slice(0, finIdx < 0 ? out.length : finIdx).filter((x) => x.event === "task.progress");
  return { fin, daemon, planner: planner.n, progress, seqs: progress.map((p) => p.seq), finSeq: out[finIdx]?.seq as number, events: progress.map((p) => p.data) };
}
const acted = (d: FakeWorkflowDaemon) => d.actions.length > 0;
const types = (r: { events: any[] }) => r.events.map((e) => e.type).join(">");

async function main() {
  console.log("\n[F1] a new workflow's name must be introduced by the user");
  {
    check(explicitlyNamed("make a routine called tidy that checks the time", "tidy") && explicitlyNamed("call it tidy", "tidy") && explicitlyNamed("a workflow named tidy", "tidy") && explicitlyNamed('save "tidy" for me', "tidy")
      && explicitlyNamed("with the name tidy", "tidy") && explicitlyNamed("by the name of tidy", "tidy") && explicitlyNamed("define a workflow, call it 'tidy', that", "tidy"), "N1 explicit introductions are accepted: called / named / call it / with the name / quotes");
    check(!explicitlyNamed("make a routine that tells me the time", "time") && !explicitlyNamed("a workflow that checks my reports", "reports") && !explicitlyNamed("make one called tidy and check the time", "time"), "N2 a word elsewhere in the sentence is never a name");
    check(explicitlyNamed('make one called "weekly report" that lists my downloads', "weekly report") && explicitlyNamed("make one called weekly report that lists my downloads", "weekly report") && !explicitlyNamed("make one called weekly report that lists my downloads", "downloads"), "N3 multi-word names, quoted or not");

    // N21 and variations: the model proposes a name taken from ordinary words; the host refuses to adopt it.
    for (const [text, name, steps] of [
      ["Make a routine that tells me the time.", "time", ["tell the time"]],
      ["Make a routine that tells me the time", "time", ["tell me the time"]],
      ["Create an automation that checks my reports.", "reports", ["check my reports"]],
      ["Save a workflow that lists my downloads and summarizes my notes.", "downloads", ["list my downloads", "summarize my notes"]],
      ["Make a routine to calculate 6*7 every morning.", "morning", ["calculate 6*7"]],
      ["Build me an automation that organizes my desktop.", "desktop", ["organize my desktop"]],
    ] as const) {
      const r = await ask(text, new Scripted(raw("save", name, [...steps])));
      check(!acted(r.daemon) && r.fin?.outcome === "refused" && !r.daemon.store.has(name) && /call/.test(r.fin!.response) && /didn't name/.test(r.fin!.response), `N4 not adopted as a name, the user is asked: ${text}`, { fin: r.fin?.response, a: r.daemon.actions });
    }
    let r = await ask("Make a routine that tells me the time.", new Scripted(raw("save", "", ["tell the time"])));
    check(!acted(r.daemon) && /What do you want to call/.test(r.fin!.response), "N5 the model gave no name: asked what to call it, nothing saved", r.fin);
    for (const [text, name, steps] of [
      ["Make a routine called tidy that tells me the time.", "tidy", ["tell the time"]],
      ["Make a routine named tidy that tells me the time.", "tidy", ["tell the time"]],
      ["Define a new workflow, call it tidy, that tells me the time.", "tidy", ["tell the time"]],
      ['Please store an automation "tidy" that tells me the time.', "tidy", ["tell the time"]],
      ["Set up a routine with the name tidy that tells me the time.", "tidy", ["tell the time"]],
      ['Make me an automation called "weekly report" that lists my downloads and then summarizes my notes.', "weekly report", ["list my downloads", "summarize my notes"]],
      ["Make me an automation called weekly report that lists my downloads.", "weekly report", ["list my downloads"]],
    ] as const) {
      r = await ask(text, new Scripted(raw("save", name, [...steps])));
      check(r.daemon.actions[0]?.tool === "workflows.save" && r.daemon.actions[0]!.args.name === name && r.daemon.store.has(name.toLowerCase()) && r.fin?.outcome === "completed", `N6 explicitly named, saved under exactly that name: ${text}`, { a: r.daemon.actions, f: r.fin?.response });
    }
    r = await ask("Make a routine called tidy that tells me the time.", new Scripted(raw("save", "time", ["tell the time"])));
    check(!acted(r.daemon) && !r.daemon.store.has("time"), "N7 the user named it tidy but the model says time: never substituted, nothing saved", r.fin);
    r = await ask("Make a routine called tidy that tells me the time.", new Scripted(raw("save", "cleanup", ["tell the time"])));
    check(!acted(r.daemon), "N8 a model-invented name is refused even when the user also named something else");
    r = await ask("Make a routine called backup that tells me the time.", new Scripted(raw("save", "backup", ["tell the time"])));
    check(!acted(r.daemon) && /already exists/.test(r.fin!.response), "N9 an explicitly named workflow that already exists: asked, daemon untouched", r.fin);
    check(validateIntent(raw("save", "time", ["tell the time"]), "Make a routine that tells me the time.", known(WORLD)).kind === "clarify", "N10 validateIntent refuses the N21 request directly (pure)");
  }

  console.log("\n[F3] ordinary time questions and a saved workflow called \"time\"");
  {
    const withTime = [...WORLD, { name: "time", steps: ["What time is it?"], schedule: null }];
    for (const text of ["What time is it?", "What's the time?", "Tell me the time.", "Can you tell me what time it is now?"]) {
      const m = new Scripted(raw("list", "time"));
      const r = await ask(text, m, new FakeWorkflowDaemon(withTime));
      check(r.planner === 1 && m.calls === 0 && !acted(r.daemon) && r.fin?.response === "(runtime answered)", `T1 reaches the normal runtime even though a workflow named time exists: ${text}`, { planner: r.planner, calls: m.calls, a: r.daemon.actions });
    }
    for (const text of ["What time is it?", "What's the time?"]) {
      const r = await ask(text, new Scripted(raw("list", "time")));
      check(r.planner === 1 && !acted(r.daemon), `T2 reaches the normal runtime when no such workflow exists: ${text}`);
    }
    let r = await ask("Create a workflow called time: Tell me the current time", new Scripted(raw("other")));
    check(r.daemon.actions[0]?.tool === "workflows.save" && r.daemon.actions[0]!.args.name === "time" && r.daemon.actions[0]!.args.steps[0] === "Tell me the current time" && r.fin?.outcome === "completed", "T3 'Create a workflow called time: Tell me the current time' still works (exact form, no model)", r.fin);
    r = await ask("Create a workflow called time: Tell me the current time", new Scripted(raw("other")), new FakeWorkflowDaemon(withTime));
    check(r.fin?.outcome === "failed" && /already exists/.test(r.fin.response) && r.daemon.store.get("time")!.steps.length === 1, "T4 when time already exists the daemon's refusal is reported and nothing changes", r.fin);
    r = await ask("Make a routine called time that tells me the current time.", new Scripted(raw("save", "time", ["tell me the current time"])));
    check(r.daemon.actions[0]?.args.name === "time" && r.daemon.store.has("time"), "T5 naming it time in natural language also works (it is explicit)", r.fin);
    const m = new Scripted(raw("delete", "time"));
    r = await ask("Delete time please", m, new FakeWorkflowDaemon(withTime));
    check(m.calls === 1 && r.daemon.actions[0]?.tool === "workflows.delete" && !r.daemon.store.has("time"), "T6 a saved workflow named time can still be managed (a management verb plus its name)", r.fin);
  }

  console.log("\n[F2] routed requests emit the runtime's progress events (the HUD's RESULT panel) truthfully");
  {
    let r = await ask("List my workflows", new Scripted(raw("other")));
    check(types(r) === "plan>step.started>step.finished>verification" && r.events[0].tools[0] === "workflow.list" && r.events[2].status === "succeeded", "E1 exact success: plan > step.started > step.finished(succeeded) > verification", types(r));
    const ids = r.seqs; check(ids.every((v: number, i: number) => i === 0 || v > ids[i - 1]) && r.finSeq > ids[ids.length - 1], "E2 events precede task.finished with increasing sequence numbers");
    let nat = toNativeResult(r.fin);
    check(r.fin?.outcome === "completed" && nat.independentlyVerified === true && nat.steps[0]?.status === "succeeded", "E3 exact success: the real request check is reported (it did happen)", nat);

    r = await ask("Could you tell me which automations I have?", new Scripted(raw("list")));
    check(types(r) === "plan>step.started>step.finished" && r.events[2].status === "succeeded", "E4 model-interpreted success: plan > step.started > step.finished, and NO verification event", types(r));
    nat = toNativeResult(r.fin);
    check(r.fin?.outcome === "completed" && nat.independentlyVerified === null && r.fin?.verification === null, "E5 model-interpreted success claims NO independent verification (the HUD shows no badge)", nat);
    check(/I understood this as: list your saved workflows/.test(r.fin!.response), "E5b the response states the interpretation");

    r = await ask("Stop the nightly job from running automatically", new Scripted(raw("unschedule", "nightly")));
    check(types(r) === "plan>step.started>step.finished" && r.fin?.outcome === "completed" && r.events[0].goal.includes("nightly"), "E6 unschedule success events", types(r));

    // refused / clarification: the runtime's own refusal shape (an 'unsupported' plan, no steps), outcome refused
    r = await ask("Delete the backup or nightly please", new Scripted(raw("delete", "backup")));
    check(types(r) === "plan" && r.events[0].intent === "unsupported" && r.events[0].stepIds.length === 0 && r.fin?.outcome === "refused" && !acted(r.daemon), "E7 clarification: an unsupported plan with no steps, outcome refused, no daemon action", { t: types(r), f: r.fin });
    const ev = progressToEvent("t", 1, r.events[0], new Date());
    check(ev?.type === "task.planned" && (ev.payload as any).nodeCount === 0, "E7b the HUD maps it to a task.planned event with 0 nodes (so its status panel renders the REFUSED result)", ev);
    r = await ask("Make a routine that tells me the time.", new Scripted(raw("save", "time", ["tell the time"])));
    check(types(r) === "plan" && r.fin?.outcome === "refused", "E8 the N21 clarification also renders", types(r));
    r = await ask("Stop it from running automatically", new Scripted(new Error("Local model unavailable")));
    check(types(r) === "plan" && r.fin?.outcome === "refused" && /model is not available/.test(r.fin!.response), "E9 model unavailable: refusal event, outcome refused", types(r));
    r = await ask("Delete the workflow nightly and the file x.txt", new Scripted(raw("other")));
    check(types(r) === "plan" && r.fin?.outcome === "refused" && !acted(r.daemon), "E10 an exact-grammar refusal also emits the refusal plan", types(r));

    // daemon-side failures and denial are reported as they were
    const d = new FakeWorkflowDaemon(WORLD); d.approve = false;
    r = await ask("Make dropme run every day at 9 AM", new Scripted(raw("schedule", "dropme")), d);
    check(types(r) === "plan>step.started>approval.denied>step.finished" && r.events[3].status === "failed" && r.fin?.outcome === "failed" && d.cardShown === 1 && d.store.get("dropme")!.schedule === null, "E11 denied schedule: approval.denied then step.finished(failed); outcome failed; nothing scheduled; the card was shown", types(r));
    nat = toNativeResult(r.fin); check(nat.independentlyVerified === null && nat.steps[0]?.status === "failed", "E11b the denial is not presented as verified", nat);
    r = await ask("Make dropme run every day at 9 AM", new Scripted(raw("schedule", "dropme")));
    check(types(r) === "plan>step.started>step.finished" && r.events[2].status === "succeeded" && r.fin?.outcome === "completed" && r.daemon.cardShown === 1, "E12 approved schedule: success events, the approval card was shown", types(r));
    r = await ask("Run the workflow nightly every day at 9 AM", new Scripted(raw("other")), (() => { const x = new FakeWorkflowDaemon(WORLD); x.approve = false; return x; })());
    check(types(r) === "plan>step.started>approval.denied>step.finished" && r.fin?.outcome !== "completed", "E13 exact-form denied schedule: the same truthful sequence", types(r));
    const gone = new FakeWorkflowDaemon(WORLD);
    r = await ask("Unschedule the workflow dropme", new Scripted(raw("other")), gone);
    check(types(r) === "plan>step.started>step.finished" && r.events[2].status === "failed" && r.fin?.outcome === "failed" && /not scheduled/.test(r.fin.response), "E14 a daemon refusal (not scheduled): step.finished(failed), outcome failed, no verification event", types(r));
    const feOff = new FakeWorkflowDaemon(WORLD); feOff.enabled = false;
    r = await ask("Run the workflow nightly every day at 9 AM", new Scripted(raw("other")), feOff);
    check(r.fin !== undefined && !acted(feOff), "E15 workflows not offered: nothing is called");
    // events never change the outcome: the same request without a sink behaves identically (daemon calls are what they were)
    r = await ask("Could you tell me which automations I have?", new Scripted(raw("list")));
    check(r.daemon.actions.length === 1 && r.daemon.actions[0]!.tool === "workflows.list", "E16 exactly one daemon action; the events add none");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
