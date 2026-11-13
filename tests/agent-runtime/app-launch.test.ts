/**
 * "Open Notepad and type HELLO": the application-session flow, agent side, through the real AgentRuntime, Planner, grounding and
 * verifier with a scripted model and a fake daemon (the daemon's launch/approval/typing are covered by AppLaunchTests.cs and the
 * guarded-input tests; the packaged HUD run is the end-to-end proof).
 * Run with: npx tsx tests/agent-runtime/app-launch.test.ts
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { Planner } from "../../agent/runtime/planner";
import { Brain } from "../../agent/runtime/brain";
import { appSession, requestedInputActions, requestedProcess, requestedTitle, actuationRefusal, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const GRANTED = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);

type Call = { tool: string; args: Record<string, any> };
class AppDaemon implements DesktopBridge {
  available = true;
  calls: Call[] = [];
  launch: DesktopReply = { status: "ok", result: { launched: true, verified: true, executed: true, app: "notepad",
    observed: 'a new Notepad window titled "Untitled - Notepad" (Notepad.exe, process 7000) is open', window: { process: "Notepad.exe", title: "Untitled - Notepad", pid: 7000 } } };
  type: DesktopReply = { status: "ok", result: { executed: true, verified: true, observed: "the control now holds the typed text",
    control: { controlType: "Document", name: "Text editor", automationId: "" }, target: { process: "Notepad.exe", title: "Untitled - Notepad", pid: 7000 } } };
  constructor(private notOffered: string[] = []) {}
  offers(tool: string) { return !this.notOffered.includes(tool); }
  async call(_taskId: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push({ tool, args });
    if (tool === "desktop.launch_app") return structuredClone(this.launch);
    if (tool === "desktop.type_text") return structuredClone(this.type);
    return { status: "ok", result: { windows: [], total: 0, returned: 0, truncated: false, complete: true, observationId: "o", capturedAtUtc: new Date().toISOString(), completedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 5000).toISOString(), filter: {}, disappeared: 0, excludedIncompleteIdentity: 0, excludedDaskWindows: 0, note: "" } } as unknown as DesktopReply;
  }
}

class Model implements LanguageModel {
  readonly name = "scripted";
  calls: StructuredRequest[] = [];
  constructor(private plans: unknown[], private assess: unknown = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "evidence shows it" }) {}
  async generateJson(req: StructuredRequest): Promise<unknown> {
    this.calls.push(req);
    if (req.purpose === "assess") return structuredClone(this.assess);
    const next = this.plans.length > 1 ? this.plans.shift() : this.plans[0];
    if (next === undefined) throw new Error("no scripted plan");
    return structuredClone(next);
  }
}
const launchStep = (id = "s1") => ({ id, description: "open Notepad", tool: "desktop.launch_app", input: { app: "notepad" } });
const typeStep = (text: string, id = "s2") => ({ id, description: "type the text", tool: "desktop.type_text", input: { process: "notepad.exe", controlType: "Document", control: "Text editor", text } });
const plan = (steps: unknown[]) => ({ intent: "task", goal: "open notepad and type", successCriteria: ["Notepad is open and contains the text"], steps });
let n = 0;
const runWith = async (objective: string, model: Model, daemon: AppDaemon) => {
  const rt = new AgentRuntime({ model, registry: createDefaultRegistry(ROOT, { desktop: daemon }), granted: GRANTED });
  return rt.run({ taskId: `t${++n}`, objective });
};
const REQ = "Open Notepad and type HELLO";

async function main() {
  console.log("[A] grammar");
  check(JSON.stringify(appSession(REQ)) === '{"app":"notepad","process":"notepad.exe","text":"HELLO"}', "A1 the failed demo request parses: Notepad, text HELLO");
  check(appSession('Please open Notepad, then type "good morning" in it.')?.text === "good morning", "A2 quoted text, polite, trailing 'in it'");
  check(appSession("Launch Notepad and write hello world.")?.text === "hello world", "A3 unquoted text stops at the sentence end");
  check(appSession("Open Notepad")?.text === null && appSession("open the notepad app.")?.text === null, "A4 open only");
  check(appSession("Open Notepad and type hello then save it") === null && appSession("Open Notepad and type hello and close it") === null, "A5 text that runs on into another instruction is refused, never guessed");
  check(appSession("Open Chrome and type hello") === null && appSession("Open Notepad and delete my files") === null && appSession("Type HELLO") === null, "A6 other applications and other actions are not an app session");
  check(appSession("Open Notepad and type " + "x".repeat(201)) === null, "A7 over-long text is refused");
  const steps = requestedInputActions(REQ);
  check(steps.length === 1 && steps[0]!.tool === "desktop.type_text" && steps[0]!.text === "HELLO" && steps[0]!.target === "Text editor" && steps[0]!.controlType === "Document", "A8 the typing step is bound to Notepad's editor control");
  check(requestedProcess(REQ) === "notepad.exe" && requestedTitle(REQ) === null && requestedTitle('Open Notepad and type "HELLO"') === null, "A9 the window is selected by process; quoted text is never mistaken for a title");
  check(actuationRefusal(REQ) === null && actuationRefusal("Open Notepad") === null, "A10 offered: not refused");
  check(actuationRefusal(REQ, (t) => t !== "desktop.launch_app") !== null, "A11 launch not offered: refused exactly as before");
  check(actuationRefusal(REQ, (t) => t !== "desktop.type_text") !== null, "A12 typing not offered: refused");

  console.log("[B] the planner is offered only the tools this request needs");
  {
    const p = new Planner(new Brain(new Model([]), 1000), createDefaultRegistry(ROOT, { desktop: new AppDaemon() }));
    check(p.toolsFor(REQ, GRANTED).map((t) => t.name).sort().join() === "desktop.launch_app,desktop.type_text", "B1 only launch_app and type_text (no window listing, no clock)", p.toolsFor(REQ, GRANTED).map((t) => t.name));
    check(p.toolsFor("Open Notepad", GRANTED).map((t) => t.name).sort().join() === "desktop.launch_app", "B2 'Open Notepad' offers only launch_app");
  }

  console.log("[C] end to end: COMPLETED only with both facets proven");
  {
    const d = new AppDaemon(); const m = new Model([plan([launchStep(), typeStep("HELLO")])]);
    const r = await runWith(REQ, m, d);
    check(r.outcome === "completed" && r.verification?.independentlyVerified === true, "C1 launch then type, both verified → completed, independently verified", { o: r.outcome, v: r.verification?.independentlyVerified, f: r.verification?.facets, g: r.verification?.grounding, u: r.verification?.unexplained });
    check(d.calls.map((c) => c.tool).join() === "desktop.launch_app,desktop.type_text", "C2 the daemon saw the launch first, then the typing", d.calls.map((c) => c.tool));
    const t = d.calls[1]!.args;
    check(d.calls[0]!.args.app === "notepad" && Object.keys(d.calls[0]!.args).join() === "app" && t.process === "notepad.exe" && t.text === "HELLO" && t.element?.controlType === "Document" && t.element?.name === "Text editor" && t.titleContains === undefined,
      "C3 exact arguments: launch {app}, typing bound to notepad.exe / Document / Text editor / HELLO", d.calls);
  }
  {
    const d = new AppDaemon(); const m = new Model([plan([launchStep()])]);
    const r = await runWith(REQ, m, d);
    check(r.outcome === "completed" && d.calls.map((c) => c.tool).join() === "desktop.launch_app,desktop.type_text", "C4 the model plans only the launch: the typing follows deterministically and the task completes", { o: r.outcome, calls: d.calls.map((c) => c.tool), plans: m.calls.filter((c) => c.purpose === "plan").length });
  }
  {
    const d = new AppDaemon(); const m = new Model([plan([launchStep()])]);
    const r = await runWith("Open Notepad", m, d);
    check(r.outcome === "completed" && d.calls.length === 1 && d.calls[0]!.tool === "desktop.launch_app", "C5 'Open Notepad' alone: launch only, verified by the new window", { o: r.outcome, c: d.calls.map((c) => c.tool) });
  }

  console.log("[D] it is never reported done without the evidence");
  {
    const d = new AppDaemon(); d.launch = { status: "error", error: { code: "approval_denied", message: "You declined. Nothing was opened." } } as DesktopReply;
    const r = await runWith(REQ, new Model([plan([launchStep(), typeStep("HELLO")])]), d);
    check(r.outcome !== "completed" && d.calls.every((c) => c.tool !== "desktop.type_text"), "D1 launch denied: not completed, and nothing is typed", { o: r.outcome, c: d.calls.map((c) => c.tool) });
    check(/declined|Nothing was opened/.test(r.response), "D1b the reason is shown", r.response);
  }
  {
    const d = new AppDaemon(); d.launch = { status: "error", error: { code: "launch_unverified", message: "Notepad was started, but no NEW Notepad window appeared." } } as DesktopReply;
    const r = await runWith(REQ, new Model([plan([launchStep(), typeStep("HELLO")])]), d);
    check(r.outcome !== "completed" && d.calls.every((c) => c.tool !== "desktop.type_text"), "D2 no new window seen: not completed, nothing typed");
  }
  {
    const d = new AppDaemon(); d.type = { status: "ok", result: { executed: true, verified: false, observed: "value unchanged" } } as DesktopReply;
    const r = await runWith(REQ, new Model([plan([launchStep(), typeStep("HELLO")])]), d);
    check(r.outcome !== "completed", "D3 typing not verified: not completed", r.outcome);
  }
  {
    const d = new AppDaemon();
    const r = await runWith(REQ, new Model([plan([typeStep("HELLO"), launchStep()])]), d);
    check(d.calls.findIndex((c) => c.tool === "desktop.type_text") < 0 || d.calls.findIndex((c) => c.tool === "desktop.launch_app") < d.calls.findIndex((c) => c.tool === "desktop.type_text"),
      "D4 typing planned before the launch never reaches the daemon first", d.calls.map((c) => c.tool));
  }
  {
    const d = new AppDaemon();
    const r = await runWith(REQ, new Model([plan([launchStep(), typeStep("hello")])]), d);
    check(r.outcome !== "completed" && d.calls.every((c) => c.tool !== "desktop.type_text" || c.args.text === "HELLO"), "D5 text other than the request's never reaches the daemon", { o: r.outcome, c: d.calls });
  }
  {
    const d = new AppDaemon();
    const listPlan = plan([{ id: "s1", description: "list notepad windows", tool: "desktop.list_windows", input: { process: "notepad.exe" } }]);
    const r = await runWith(REQ, new Model([listPlan]), d);
    check(r.outcome === "completed" && d.calls.map((c) => c.tool).join() === "desktop.launch_app,desktop.type_text",
      "D6 the ORIGINAL FAILURE (the model plans a window listing): the request's own order is applied, Notepad is opened and typed into, the listing never runs", { o: r.outcome, c: d.calls.map((c) => c.tool) });
    const d3 = new AppDaemon();
    const r3 = await runWith(REQ, new Model([plan([typeStep("HELLO")])]), d3);
    check(r3.outcome === "completed" && d3.calls.map((c) => c.tool).join() === "desktop.launch_app,desktop.type_text",
      "D6b the model plans only the typing (the real-model plan in the first packaged run): the launch is put first and the task completes", { o: r3.outcome, c: d3.calls.map((c) => c.tool) });
  }
  {
    const d = new AppDaemon();
    await runWith(REQ, new Model([plan([launchStep(), typeStep("HELLO")])]), d);
    const d2 = new AppDaemon();
    const r2 = await runWith(REQ, new Model([plan([typeStep("HELLO")])]), d2);
    check(!d2.calls.some((c) => c.tool === "desktop.type_text") || d2.calls[0]!.tool === "desktop.launch_app", "D7 a launch in an earlier task does not license typing in a later one", d2.calls.map((c) => c.tool));
  }

  console.log("\n[E] More applications from the daemon's list (open only)");
  check(appSession("Open Calculator")?.app === "calculator" && appSession("please launch the calculator app")?.app === "calculator" && appSession("open calc")?.app === "calculator", "E1 Calculator phrasings");
  check(appSession("Open Character Map")?.app === "charmap" && appSession("start charmap")?.process === "charmap.exe", "E2 Character Map phrasings");
  check(appSession("Open Calculator and type 2+2") === null && appSession("open character map and type x") === null, "E3 typing is offered only for Notepad");
  check(appSession("open calculus notes") === null && appSession("open the calculator.exe from D:\\x") === null, "E4 no partial-word or path matches");
  {
    const d = new AppDaemon();
    const r = await runWith("Open Calculator", new Model([plan([{ id: "s1", description: "open", tool: "desktop.launch_app", input: { app: "calculator" }, dependsOn: [] }])]), d);
    check(d.calls.length === 1 && d.calls[0]!.tool === "desktop.launch_app" && (d.calls[0]!.args as { app: string }).app === "calculator", "E5 'Open Calculator' asks the daemon to open exactly calculator", d.calls);
    void r;
    const d3 = new AppDaemon();
    await runWith("Open Calculator", new Model([plan([{ id: "s1", description: "open", tool: "desktop.launch_app", input: { app: "notepad" }, dependsOn: [] }])]), d3);
    check(!d3.calls.some((c) => (c.args as { app?: string }).app === "notepad"), "E6 the model cannot substitute another application", d3.calls);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
