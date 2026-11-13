/**
 * The VALIDATION layer of natural-language workflow management, through the real AgentHost, with a SCRIPTED model.
 * This proves what the host does with whatever the model says (including wrong, hostile or malformed output): no unsafe daemon call is possible.
 * It does NOT measure language understanding: that is tests/agent-runtime/workflow-intent.eval.ts (real model, held-out sentences).
 * Run with: npx tsx tests/agent-runtime/workflow-intent.test.ts
 */
import { AgentHost } from "../../agent/host/host";
import { validateIntent, clockTimes, timingOf, groundedIn } from "../../agent/host/workflowIntent";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";
import { FakeWorkflowDaemon } from "./fixtures/fakeWorkflowDaemon";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const WORLD = [
  { name: "nightly", steps: ["What is 2+3?"], schedule: "daily 21:00" },
  { name: "dropme", steps: ["What is 7+8?"], schedule: null },
  { name: "morning check", steps: ["What time is it?"], schedule: "weekly monday 08:00" },
  { name: "backup", steps: ["What is 1+1?"], schedule: "daily 02:00" },
  { name: "backup-weekly", steps: ["What is 1+1?"], schedule: "weekly sunday 03:00" },
];
/** The pure validator takes step COUNTS; the fake daemon world keeps the step texts. */
const known = (w: readonly { name: string; steps: readonly string[]; schedule: string | null }[]) => w.map((x) => ({ name: x.name, steps: x.steps.length, schedule: x.schedule }));

const raw = (operation: string, workflow_name = "", steps: string[] = [], ask = "") => ({ operation, workflow_name, steps, ask });

class Scripted implements LanguageModel {
  readonly name = "scripted"; calls = 0; lastSystem = "";
  constructor(private out: unknown | (() => unknown) | Error) {}
  async generateJson(req: StructuredRequest) { this.calls++; this.lastSystem = req.system; if (this.out instanceof Error) throw this.out; return typeof this.out === "function" ? (this.out as () => unknown)() : structuredClone(this.out); }
}
let n = 0;
async function ask(objective: string, model: LanguageModel | undefined, daemon = new FakeWorkflowDaemon(WORLD)) {
  const planner = { n: 0 }; const out: any[] = [];
  const host = new AgentHost({ writeLine: (l) => out.push(JSON.parse(l)), log: () => {}, token: "tok", exit: () => {}, desktop: daemon as any, model,
    runtime: { run: async (o: any) => { planner.n++; return { taskId: o.taskId, outcome: "completed", plan: null, steps: [], verification: null, response: "(planner)", iterations: 1, toolCalls: 0 }; } } as any });
  host.handleLine(JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "tok", emergencyStopped: false, stopGeneration: 0 } }));
  host.handleLine(JSON.stringify({ v: 1, id: "q1", op: "submit", params: { taskId: `t${++n}`, objective } }));
  for (let i = 0; i < 200 && !out.some((x) => x.event === "task.finished"); i++) await tick();
  const fin = out.find((x) => x.event === "task.finished")?.data as { outcome: string; response: string } | undefined;
  return { fin, daemon, planner: planner.n };
}
const acted = (d: FakeWorkflowDaemon) => d.actions.length > 0;

async function main() {
  console.log("\n[V] a correct model description of different natural phrasings becomes the right, validated daemon call");
  {
    let r = await ask("Could you stop nightly from firing by itself every evening?", new Scripted(raw("unschedule", "nightly")));
    check(r.fin?.outcome === "completed" && r.daemon.actions.length === 1 && r.daemon.actions[0]!.tool === "workflows.unschedule" && r.daemon.actions[0]!.args.name === "nightly" && /I understood this as: stop the workflow "nightly"/.test(r.fin!.response), "V1 unschedule: right tool, the workflow's saved spelling, and the host says what it understood", r.fin);
    r = await ask("Hey, I'd like nightly to go every Monday morning at 9", new Scripted(raw("schedule", "nightly")));
    check(r.daemon.actions[0]?.tool === "workflows.schedule" && JSON.stringify(r.daemon.actions[0]!.args) === JSON.stringify({ name: "nightly", kind: "weekly", time: "09:00", day: "monday" }) && r.daemon.cardShown === 1, "V2 schedule: the host derived weekly/monday/09:00 from the user's words; the daemon's approval was consulted", r.daemon.actions);
    r = await ask("what do i have saved as workflows", new Scripted(raw("list")));
    check(r.daemon.actions.length === 1 && r.daemon.actions[0]!.tool === "workflows.list" && /nightly: 1 step/.test(r.fin!.response), "V3 list", r.fin);
    r = await ask("I don't need the dropme workflow any more, please throw it out", new Scripted(raw("delete", "dropme")));
    check(r.daemon.actions[0]?.tool === "workflows.delete" && !r.daemon.store.has("dropme"), "V4 delete", r.daemon.actions);
    r = await ask("Please make an automation named cleaner that empties my downloads folder; then lists my documents.", new Scripted(raw("save", "cleaner", ["empty my downloads folder", "list my documents"])));
    check(r.daemon.actions[0]?.tool === "workflows.save" && r.daemon.store.has("cleaner") && r.daemon.store.get("cleaner")!.steps.length === 2, "V5 save with steps grounded in the user's words", r.daemon.actions);
  }

  console.log("\n[M] malformed, missing or failing model output: a question or a safe refusal, never an action");
  for (const [label, out] of [
    ["not an object", "hello"], ["null", null], ["array", []], ["unknown operation", raw("explode", "nightly")], ["missing fields", { operation: "list" }],
    ["wrong field type", { operation: "list", workflow_name: 5, steps: [], ask: "" }], ["steps not an array", { operation: "save", workflow_name: "x", steps: "do it", ask: "" }],
    ["oversized name", raw("delete", "x".repeat(60))], ["too many steps", raw("save", "zzz", Array(9).fill("do something here"))],
  ] as const) {
    const r = await ask("Please stop nightly from running automatically", new Scripted(out));
    check(!acted(r.daemon) && r.planner === 0 && r.fin?.outcome === "refused", `M1 ${label}: no daemon action, no planner`, { fin: r.fin, calls: r.daemon.actions });
  }
  {
    const r = await ask("Please stop nightly from running automatically", new Scripted(new Error("Local model unavailable: memory guard")));
    check(!acted(r.daemon) && r.planner === 0 && r.fin?.outcome === "refused" && /model is not available/.test(r.fin!.response) && /Unschedule the workflow NAME/.test(r.fin!.response), "M2 the model is unavailable: nothing done, and the exact forms that need no model are offered", r.fin);
    const r2 = await ask("Unschedule the workflow dropme.", new Scripted(new Error("boom")));
    check(r2.fin?.outcome !== "completed" || r2.daemon.actions[0]?.tool === "workflows.unschedule", "M3 the exact request path does not need the model at all (it never asked)");
    const m3 = new Scripted(raw("other")); await ask("Unschedule the workflow nightly", m3);
    check(m3.calls === 0, "M3b an exact request never calls the model");
    const r4 = await ask("Stop nightly from running automatically", undefined);
    check(!acted(r4.daemon) && r4.planner === 1, "M4 no model configured: not claimed, goes to the runtime exactly as before");
  }

  console.log("\n[H] the model cannot widen what the user said (hallucination and hostile output)");
  {
    let r = await ask("Stop it from running automatically", new Scripted(raw("unschedule", "nightly")));
    check(!acted(r.daemon) && r.fin?.outcome === "refused", "H1 the model names a workflow the user never mentioned: a question, no action", r.fin);
    r = await ask("Delete my backup one", new Scripted(raw("delete", "backup")));
    check(!acted(r.daemon), "H2 an unquoted partial/ambiguous reference is not resolved by guessing", { fin: r.fin, a: r.daemon.actions });
    r = await ask("Remove my morning automation", new Scripted(raw("delete", "morning check")));
    check(!acted(r.daemon) && /Did you mean "morning check"/.test(r.fin!.response), "H3 only a partial name match: offered as a question, never auto-picked", r.fin);
    r = await ask("Make a workflow called cleaner that checks my reports", new Scripted(raw("save", "cleaner", ["delete all my files", "format the disk"])));
    check(!acted(r.daemon) && /words you didn't say/.test(r.fin!.response), "H4 steps the model made up (words the user never said) are refused", r.fin);
    r = await ask("Make a workflow called cleaner that checks my reports", new Scripted(raw("save", "other-name", ["check my reports"])));
    check(!acted(r.daemon), "H5 a name the user did not write is refused", r.fin);
    r = await ask("Schedule dropme every day", new Scripted(raw("schedule", "dropme")));
    check(!acted(r.daemon) && /What time/.test(r.fin!.response), "H6 no clock time stated: asked for, never invented (the model cannot supply one)", r.fin);
    r = await ask("Run dropme every day at 9 AM", new Scripted({ operation: "schedule", workflow_name: "dropme", steps: [], ask: "", time24: "03:00", repeat: "weekly" }));
    check(r.daemon.actions[0]?.tool === "workflows.schedule" && r.daemon.actions[0]!.args.time === "09:00" && r.daemon.actions[0]!.args.kind === "daily", "H7 time and repeat come from the user's words; extra/contradicting model fields are ignored", r.daemon.actions);
    r = await ask("Delete nightly", new Scripted(raw("save", "nightly", ["do things here"])));
    check(!acted(r.daemon), "H8 the model's operation must be supported by the user's own words (a delete request cannot become a save)", { fin: r.fin, a: r.daemon.actions });
    r = await ask("Create a workflow called temp that checks the time", new Scripted(raw("delete", "nightly")));
    check(!acted(r.daemon), "H9 a create request the model calls delete: refused, nothing deleted", { fin: r.fin, a: r.daemon.actions });
    r = await ask("Can you schedule it for me", new Scripted(raw("schedule", "nightly")));
    check(!acted(r.daemon), "H10 'it' with no workflow named: not resolved by the model's guess", r.fin);
  }

  console.log("\n[D] delete and unschedule are never converted into each other");
  {
    let r = await ask("I no longer need the dropme workflow", new Scripted(raw("unschedule", "dropme")));
    check(!acted(r.daemon) && /delete the workflow "dropme" entirely, or only stop/.test(r.fin!.response), "D1 'no longer need X' said as unschedule: asked which, nothing done", r.fin);
    r = await ask("Remove the daily trigger from nightly", new Scripted(raw("delete", "nightly")));
    check(!acted(r.daemon) && /entirely, or only stop/.test(r.fin!.response) && r.daemon.store.has("nightly"), "D2 a trigger removal the model calls delete: asked, the workflow is kept", r.fin);
    r = await ask("Remove the daily trigger from nightly", new Scripted(raw("unschedule", "nightly")));
    check(r.daemon.actions[0]?.tool === "workflows.unschedule" && r.daemon.store.has("nightly"), "D3 the same request described correctly: unschedule, workflow kept", r.daemon.actions);
    r = await ask("Delete nightly but keep it", new Scripted(raw("delete", "nightly")));
    check(!acted(r.daemon) && r.daemon.store.has("nightly"), "D4 delete-but-keep contradiction: asked", r.fin);
    r = await ask("Get rid of backup-weekly", new Scripted(raw("delete", "backup-weekly")));
    check(r.daemon.actions[0]?.tool === "workflows.delete" && r.daemon.actions[0]!.args.name === "backup-weekly", "D5 a workflow's own name containing 'weekly' is not read as scheduling words", r.daemon.actions);
    r = await ask("Delete nightly and then unschedule backup", new Scripted(raw("delete", "nightly")));
    check(!acted(r.daemon) && /one workflow operation per request/.test(r.fin!.response), "D6 two operations in one request: one at a time", r.fin);
  }

  console.log("\n[S] schedule expressions are validated by the host");
  {
    const bad: [string, string][] = [
      ["Make dropme run every weekday at 9 AM", "one weekday at a time"], ["Run dropme every other Tuesday at 10", "every other"], ["Run dropme every 30 minutes", "intervals"],
      ["Schedule dropme monthly at 9", "monthly"], ["Schedule dropme at 25:61 daily", "read that time"], ["Schedule dropme on 2027-02-30 at 9:00", "date doesn't exist"],
      ["Schedule dropme every day at 8 AM and every Friday at 9 PM", "more than one"], ["Schedule dropme every Monday and Tuesday at 9", "one weekday"], ["I want dropme to execute every Monday morning", "exact time"],
      ["Schedule dropme every day at 8 and at 9 PM", "more than one time"],
    ];
    for (const [text, why] of bad) {
      const r = await ask(text, new Scripted(raw("schedule", "dropme")));
      check(!acted(r.daemon) && new RegExp(why, "i").test(r.fin?.response ?? ""), `S1 refused, no daemon action: ${text}`, r.fin?.response);
    }
    const good: [string, any][] = [
      ["Have dropme go each evening at 6:30 PM", { kind: "daily", time: "18:30" }], ["dropme at noon every day please", { kind: "daily", time: "12:00" }], ["dropme at midnight every night", { kind: "daily", time: "00:00" }],
      ["Run dropme every Friday at seven in the morning", { kind: "weekly", day: "friday", time: "07:00" }], ["set dropme for 2027-01-15 at 8:15", { kind: "once", date: "2027-01-15", time: "08:15" }],
      ["dropme every Sunday at 11 at night", { kind: "weekly", day: "sunday", time: "23:00" }],
    ];
    for (const [text, expect] of good) {
      const r = await ask(text, new Scripted(raw("schedule", "dropme")));
      const a = r.daemon.actions[0];
      check(a?.tool === "workflows.schedule" && Object.entries(expect).every(([k, v]) => a.args[k] === v), `S2 derived exactly: ${text}`, a?.args ?? r.fin?.response);
    }
    const r = await ask("Run dropme every day at 9 AM", new Scripted(raw("schedule", "dropme")));
    check(r.daemon.cardShown === 1 && r.daemon.store.get("dropme")!.schedule === "every day at 09:00", "S3 the daemon's approval card is still shown for a natural-language schedule");
    const d = new FakeWorkflowDaemon(WORLD); d.approve = false;
    const rd = await ask("Run dropme every day at 9 AM", new Scripted(raw("schedule", "dropme")), d);
    check(rd.fin?.outcome === "failed" && /not approved/.test(rd.fin.response) && d.store.get("dropme")!.schedule === null && d.cardShown === 1, "S4 approval denied: not completed, nothing scheduled, honestly reported", rd.fin);
    const dis = new FakeWorkflowDaemon(WORLD); dis.enabled = false;
    const rn = await ask("Run dropme every day at 9 AM", new Scripted(raw("schedule", "dropme")), dis);
    check(dis.calls.length === 0 && rn.planner === 1, "S5 workflows not offered by the daemon: nothing claimed, no calls");
  }

  console.log("\n[N] requests that are not workflow management are not claimed (they reach the runtime exactly as before)");
  for (const [text, out] of [["What time is it?", raw("other")], ["Summarize notes.txt", raw("other")], ["What's on my schedule today?", raw("other")], ["Please run nightly now", raw("run", "nightly")], ["Is the nightly news on tonight?", raw("other")]] as const) {
    const r = await ask(text, new Scripted(out));
    check(!acted(r.daemon) && r.planner === 1, `N1 not claimed → runtime: ${text}`, { planner: r.planner, a: r.daemon.actions });
  }
  {
    const m = new Scripted(raw("other")); const r = await ask("Open Notepad", m);
    check(m.calls === 0 && r.planner === 1, "N2 a request with no workflow-ish words and no known name never reaches the model");
    const m2 = new Scripted(raw("list")); const r2 = await ask("What does the word routine mean?", m2);
    check(!acted(r2.daemon), "N3 a question about a word is not a list request even if the model says list", r2.fin);
  }

  console.log("\n[R] regressions for defects the first held-out run exposed");
  {
    const t = (s: string) => JSON.stringify(clockTimes(s).times);
    check(t("half past five in the afternoon") === '["17:30"]' && t("a quarter to six in the evening") === '["17:45"]' && t("ten past 9 pm") === '["21:10"]' && t("twenty five to eight") === '["07:35"]', "R1 relative clock times are read whole, never as just 'five' (the old 17:00 for 'half past five')");
    check(t("from 9 to 5") === "[]" && t("every 15 minutes") === "[]", "R2 a range or an interval is not a relative time");
    let r = await ask("Start dropme daily at half past five in the afternoon", new Scripted(raw("schedule", "dropme")));
    check(r.daemon.actions[0]?.args.time === "17:30", "R3 the schedule the daemon is asked to approve says 17:30", r.daemon.actions);
    const m = new Scripted(raw("unschedule", "dropme")); r = await ask("Unschedule the check", m);
    check(m.calls === 1 && r.planner === 0 && !acted(r.daemon), "R4 'Unschedule …' reaches the interpreter (the gate misread the word boundary); the partial name is only offered", r.fin);
    r = await ask("Wipe the morning check routine from my list", new Scripted(raw("list", "morning check")));
    check(!acted(r.daemon) && /whether you meant to delete/.test(r.fin!.response), "R5 the model says list but the user's verb is wipe/delete: asked, nothing done (not even a read)", r.fin);
    r = await ask("What's on my schedule today?", new Scripted(raw("list")));
    check(!acted(r.daemon), "R6 a calendar-style question is not a workflow list", r.fin);
    r = await ask("Cancel the scheduled execution of nightly", new Scripted(raw("schedule", "nightly")));
    check(!acted(r.daemon) && r.daemon.cardShown === 0, "R7 the model says schedule but the user said cancel: asked, no schedule card raised", r.fin);
    r = await ask("Create an automation named cleanup that empties my downloads", new Scripted(raw("list", "cleanup")));
    check(!acted(r.daemon), "R8 a create request the model calls list: asked, nothing done", r.fin);
  }

  console.log("\n[R2] regressions for defects the second held-out run exposed");
  {
    const t = (s: string) => clockTimes(s);
    check(JSON.stringify(t("tonight at 11").times) === '["23:00"]' && JSON.stringify(t("each morning at 7").times) === '["07:00"]' && t("at 7 every day").ambiguousHour, "R2a a bare hour is decided by the user's own morning/evening words, else it is asked (never guessed)");
    check(JSON.stringify(t("eight thirty PM").times) === '["20:30"]' && t("eight forty-seven pm").invalid && JSON.stringify(t("twenty past nine in the morning").times) === '["09:20"]', "R2b number-word minutes are read whole; an unreadable one is refused, never half-read");
    let r = await ask("Could you get dropme going at 7 every day", new Scripted(raw("schedule", "dropme")));
    check(!acted(r.daemon) && /AM or PM/.test(r.fin!.response), "R2c ambiguous AM/PM: asked, no schedule card", r.fin);
    r = await ask("Unschedule nightly but make sure it runs every day", new Scripted(raw("unschedule", "nightly")));
    check(!acted(r.daemon) && /two parts that pull/.test(r.fin!.response), "R2d a contrast that re-asserts running contradicts a stop request: asked", r.fin);
    r = await ask("Cancel nightly's schedule but keep the workflow saved", new Scripted(raw("unschedule", "nightly")));
    check(r.daemon.actions[0]?.tool === "workflows.unschedule", "R2e a plain 'but keep it' does not block an unschedule", r.fin);
    r = await ask("What does nightly mean?", new Scripted(raw("list", "nightly")));
    check(!acted(r.daemon), "R2f a known name alone does not make a question a list request", r.fin);
    r = await ask("Make backup run Wednesdays at 4:45 in the afternoon", new Scripted(raw("schedule", "backup")));
    check(r.daemon.actions[0]?.args.kind === "weekly" && r.daemon.actions[0]?.args.day === "wednesday" && r.daemon.actions[0]?.args.time === "16:45", "R2g plural weekday means weekly", r.daemon.actions);
    r = await ask("backup-weekly mustn't run on its own anymore", new Scripted(raw("unschedule", "backup")));
    check(r.daemon.actions[0]?.args.name === "backup-weekly", "R2h the user wrote backup-weekly; a model that truncated it to backup does not redirect the action", r.daemon.actions);
    r = await ask("Let nightly rest, no more automatic runs", new Scripted(raw("unschedule", "nightly")));
    check(r.daemon.actions[0]?.tool === "workflows.unschedule", "R2i 'no more' is accepted as stop wording", r.fin);
  }

  console.log("\n[P] pure helpers");
  check(JSON.stringify(clockTimes("at 9 PM").times) === '["21:00"]' && JSON.stringify(clockTimes("2+3 and 12*12 and the 1st").times) === "[]" && clockTimes("every 15 minutes").times.length === 0, "P1 clock times: digits in arithmetic/ordinals/intervals are not times");
  check(timingOf("every day at 9").kinds.has("daily") && timingOf("on 2027-13-45").dateInvalid, "P2 timing");
  check(groundedIn("check my reports", "a workflow that checks my reports") && !groundedIn("format the disk", "a workflow that checks my reports"), "P3 step grounding (stem-based, never new words)");
  check(validateIntent(raw("list"), "list my workflows", known(WORLD)).kind === "call" && validateIntent("junk", "list my workflows", known(WORLD)).kind === "clarify", "P4 validateIntent is pure and fails closed");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
