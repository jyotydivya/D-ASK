/**
 * Universal application control, agent side (agent/runtime/tools/desktop.ts): "open <any installed application>", Windows Settings pages,
 * and the installed-applications list. The application is always the NAME the user said (the daemon resolves it; the model can never pick
 * a different one, a path or a command), and these tools appear only when the daemon offers them.
 * Run with: npx tsx tests/agent-runtime/universal-apps.test.ts
 */
import { createDesktopTools, openAppRequest, openTargetRequest, settingsRequest, installedAppsRequest, wordDocumentRequest, excelWorkbookRequest, devTaskRequest, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import type { ToolSpec } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}

class Bridge implements DesktopBridge {
  readonly available = true;
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly offered: string[], private readonly reply: (tool: string, args: any) => DesktopReply) {}
  offers(tool: string) { return this.offered.includes(tool); }
  async call(_t: string, tool: string, args: Record<string, unknown>) { this.calls.push({ tool, args }); return this.reply(tool, args); }
}
const ALL = ["desktop.list_windows", "desktop.launch_app", "desktop.open_settings", "desktop.list_apps", "desktop.type_text"];
const tool = (b: DesktopBridge, name: string) => createDesktopTools(b).find((t) => t.name === name)! as ToolSpec<any, any>;
const ctx = { taskId: "t1", signal: new AbortController().signal } as any;

async function main() {
  console.log("[G] grammar");
  check(openAppRequest("Open Microsoft Word.") === "Microsoft Word" && openAppRequest("launch Excel") === "Excel" && openAppRequest("Open VS Code") === "VS Code", "G1 any application name is taken as said");
  check(openAppRequest("open file explorer") === "file explorer" && openAppRequest("open Windows Terminal") === "Windows Terminal", "G2 names starting with 'file'/'windows' that are applications");
  for (const q of ["open the file report.pdf", "open https://example.com", "open example.com", "open my documents folder", "open Chrome and search for cats", "run the backup workflow", "open the page", "open windows", "open C:\\tools\\x.exe", "open \"word\""])
    check(openAppRequest(q) === null, `G3 not an application name: ${q}`);
  check(settingsRequest("Open Windows Settings and navigate to Display") === "display" && settingsRequest("open display settings") === "display" && settingsRequest("open settings") === "", "G4 Settings pages");
  check(installedAppsRequest("List installed apps")?.filter === null && installedAppsRequest("show installed programs named visual studio")?.filter === "visual studio", "G5 installed-apps list");

  console.log("[L] launch any installed application");
  const b = new Bridge(ALL, () => ({ status: "ok", result: { launched: true, verified: true, app: "Word", observed: "a new Word window titled \"Word\" (WINWORD.EXE, process 1) is open" } }));
  const launch = tool(b, "desktop.launch_app");
  const rc = launch.requestCheck!;
  check(rc.relevant!("Open Microsoft Word.") && rc.claims!("Open Microsoft Word."), "L1 the launch tool owns 'open <app>'");
  check(rc.ground({ app: "Microsoft Word" }, "Open Microsoft Word.").status === "grounded", "L2 the user's own name is grounded");
  check(rc.ground({ app: "cmd" }, "Open Microsoft Word.").status === "contradicted" && rc.ground({ app: "C:\\Windows\\System32\\cmd.exe" }, "Open Microsoft Word.").status === "contradicted", "L3 the model cannot substitute another application or a path");
  check(JSON.stringify(rc.facets("Open Microsoft Word.")) === JSON.stringify([{ id: "app:launch:microsoft word", tool: "desktop.launch_app", description: "open Microsoft Word", data: { app: "Microsoft Word" } }]), "L4 one facet: open that application", rc.facets("Open Microsoft Word."));
  const plan = rc.arrangeSteps!([{ id: "x", description: "list", tool: "desktop.list_windows", input: {} }], "Open Microsoft Word.");
  check(plan.length === 1 && plan[0]!.tool === "desktop.launch_app" && (plan[0]!.input as any).app === "Microsoft Word", "L5 the plan is exactly the launch", plan);
  const out = await launch.execute({ app: "Microsoft Word" }, ctx);
  check(out.ok && b.calls[0]!.tool === "desktop.launch_app" && (b.calls[0]!.args as any).app === "Microsoft Word" && /Opened Word/.test(out.evidence), "L6 the daemon receives the name; success only on its verified window", out);
  check(rc.satisfies!(rc.facets("Open Microsoft Word.")[0]!, { app: "Microsoft Word" }, out), "L7 satisfied only by a launched AND verified result");
  const bad = await tool(new Bridge(ALL, () => ({ status: "error", error: { code: "app_ambiguous", message: "Several installed applications match \"visual studio\": Visual Studio 2022; Visual Studio Code. Say which one." } })), "desktop.launch_app").execute({ app: "visual studio" }, { ...ctx, taskId: "t2" });
  check(!bad.ok && /Say which one/.test(bad.error ?? ""), "L8 ambiguity comes back as a question, nothing opened", bad);

  console.log("[O] offered only when the daemon offers it");
  const fixedOnly = new Bridge(["desktop.launch_app", "desktop.type_text"], () => ({ status: "ok" }));
  const lf = tool(fixedOnly, "desktop.launch_app").requestCheck!;
  check(!lf.relevant!("Open Microsoft Word.") && lf.relevant!("open notepad"), "O1 without the daemon's catalog only the fixed list is offered (as before)");
  check(!tool(fixedOnly, "desktop.open_settings").requestCheck!.relevant!("open display settings") && !tool(fixedOnly, "desktop.list_apps").requestCheck!.relevant!("List installed apps"), "O2 Settings and the list need the daemon to offer them");
  check(tool(b, "desktop.launch_app").requestCheck!.ground({ app: "notepad" }, "open notepad").status === "grounded", "O3 the fixed-list path (Notepad, with typing) is unchanged");

  console.log("[S] Settings pages");
  const sb = new Bridge(ALL, () => ({ status: "ok", result: { opened: true, verified: true, page: "Display", observed: "the Settings window \"Settings\" is open and shows \"Display\"" } }));
  const st = tool(sb, "desktop.open_settings");
  check(st.requestCheck!.claims!("Open Windows Settings and navigate to Display") && st.requestCheck!.ground({ page: "display" }, "Open Windows Settings and navigate to Display").status === "grounded", "S1 the page is the one named");
  check(st.requestCheck!.ground({ page: "privacy" }, "open display settings").status === "contradicted", "S2 the model cannot pick another page");
  const so = await st.execute({ page: "display" }, ctx);
  check(so.ok && sb.calls[0]!.tool === "desktop.open_settings" && /shows "Display"/.test(so.evidence), "S3 confirmed only when the page is on screen", so);
  check(st.requiresApproval === false && st.risk === "low", "S4 low risk: no approval card (the daemon still gates and audits it)");
  check(!tool(b, "desktop.launch_app").requestCheck!.relevant!("open display settings"), "S5 'open … settings' is never treated as an application name");

  console.log("[A] installed applications (read-only)");
  const ab = new Bridge(ALL, () => ({ status: "ok", result: { count: 166, shown: 2, apps: [{ name: "Visual Studio 2022" }, { name: "Visual Studio Code" }] } }));
  const la = tool(ab, "desktop.list_apps");
  const lo = await la.execute({ filter: "visual studio" }, ctx);
  check(lo.ok && /2 of 166/.test(lo.evidence) && /Visual Studio Code/.test(lo.evidence), "A1 lists what Windows registers", lo);
  check(la.permissions.join() === "read:desktop" && la.requiresApproval === false, "A2 read-only");

  console.log("[T] an application WITH a web search or a folder");
  const FOLDER = String.raw`D:\D-ASK\D-ASK`;
  check(JSON.stringify(openTargetRequest("Open Chrome and search for offline speech recognition")) === JSON.stringify({ app: "Chrome", search: "offline speech recognition" }), "T1 'open Chrome and search for …'");
  check(JSON.stringify(openTargetRequest(`Open the folder ${FOLDER} in VS Code`)) === JSON.stringify({ app: "VS Code", folder: FOLDER }) &&
        JSON.stringify(openTargetRequest(`open VS Code with the project ${FOLDER}.`)) === JSON.stringify({ app: "VS Code", folder: FOLDER }), "T2 a folder in VS Code (both phrasings)", openTargetRequest(`Open the folder ${FOLDER} in VS Code`));
  check(openTargetRequest("Open Chrome and search") === null && openAppRequest("Open Chrome and search for cats") === null, "T3 no search words: not a search; never a plain 'open' either");
  const tb = new Bridge(ALL, () => ({ status: "ok", result: { launched: true, verified: true, app: "Google Chrome", observed: "x" } }));
  const tl = tool(tb, "desktop.launch_app").requestCheck!;
  const sq = "Open Chrome and search for offline speech recognition";
  check(tl.claims!(sq) && tl.ground({ app: "Chrome", search: "offline speech recognition" }, sq).status === "grounded", "T4 the search is grounded in the request");
  check(tl.ground({ app: "Chrome", search: "something else" }, sq).status === "contradicted" && tl.ground({ app: "Chrome" }, sq).status === "contradicted" &&
        tl.ground({ app: "Chrome", search: "offline speech recognition", folder: "C:\\" }, sq).status === "contradicted", "T5 the model cannot change, drop or add to the search");
  check(tl.ground({ app: "Microsoft Word", search: "x" }, "Open Microsoft Word.").status === "contradicted", "T6 no search may be added to a plain 'open'");
  await tool(tb, "desktop.launch_app").execute({ app: "Chrome", search: "offline speech recognition" }, { ...ctx, taskId: "t3" });
  check(JSON.stringify(tb.calls.at(-1)!.args) === JSON.stringify({ app: "Chrome", search: "offline speech recognition" }), "T7 the daemon receives the name and the words (it builds the URL itself)", tb.calls.at(-1));

  console.log("[W] Word and Excel");
  const wq = `Create a Word document named Project summary with the heading "Project summary" and the text "D-ASK opened Word and wrote this."`;
  check(JSON.stringify(wordDocumentRequest(wq)) === JSON.stringify({ name: "Project summary", heading: true, paragraphs: ["Project summary", "D-ASK opened Word and wrote this."] }), "W1 Word: name, heading and paragraph as said", wordDocumentRequest(wq));
  check(JSON.stringify(wordDocumentRequest(`create a new word document called Notes with text "Hello."`)) === JSON.stringify({ name: "Notes", heading: false, paragraphs: ["Hello."] }), "W2 Word without a heading");
  const eq = "Create an Excel workbook named Budget with rows: Item, Cost; Laptop, 1200; Mouse, 25";
  check(JSON.stringify(excelWorkbookRequest(eq)) === JSON.stringify({ name: "Budget", rows: [["Item", "Cost"], ["Laptop", "1200"], ["Mouse", "25"]] }), "W3 Excel rows as said", excelWorkbookRequest(eq));
  const ob = new Bridge([...ALL, "office.create_word_document", "office.create_excel_workbook"], () => ({ status: "ok", result: { created: true, verified: true, file: "C:\\Users\\u\\Documents\\Budget.xlsx", observed: "Budget.xlsx is saved with 3 row(s)" } }));
  const wt = tool(ob, "office.create_word_document").requestCheck!, et = tool(ob, "office.create_excel_workbook").requestCheck!;
  check(wt.claims!(wq) && wt.ground({ name: "Project summary", heading: true, paragraphs: ["Project summary", "D-ASK opened Word and wrote this."] }, wq).status === "grounded", "W4 Word input grounded");
  check(wt.ground({ name: "Project summary", heading: true, paragraphs: ["Project summary", "Something the model made up."] }, wq).status === "contradicted" &&
        wt.ground({ name: "Other", heading: true, paragraphs: ["Project summary", "D-ASK opened Word and wrote this."] }, wq).status === "contradicted", "W5 the model cannot change the text or the file name");
  check(et.ground({ name: "Budget", rows: [["Item", "Cost"], ["Laptop", "1200"], ["Mouse", "25"]] }, eq).status === "grounded" &&
        et.ground({ name: "Budget", rows: [["Item", "Cost"], ["Laptop", "9999"], ["Mouse", "25"]] }, eq).status === "contradicted", "W6 Excel cells exactly as said");
  check(!tool(new Bridge(ALL, () => ({ status: "ok" })), "office.create_word_document").requestCheck!.relevant!(wq), "W7 offered only when the daemon offers it");
  const eo = await tool(ob, "office.create_excel_workbook").execute({ name: "Budget", rows: [["Item", "Cost"]] }, ctx);
  check(eo.ok && /Budget\.xlsx is saved/.test(eo.evidence), "W8 success only on the daemon's read-back verification", eo);

  console.log("[D] build / test a project folder");
  const PROJ = String.raw`D:\Projects\calc`;
  check(JSON.stringify(devTaskRequest(`Run the tests in ${PROJ}`)) === JSON.stringify({ folder: PROJ, task: "test" }) &&
        JSON.stringify(devTaskRequest(`build the project ${PROJ}.`)) === JSON.stringify({ folder: PROJ, task: "build" }), "D1 'run the tests in …' / 'build the project …'");
  check(devTaskRequest("run the tests") === null && devTaskRequest("build my app") === null, "D2 no folder named: not a dev request (never guessed)");
  const db = new Bridge([...ALL, "dev.run_task"], () => ({ status: "ok", result: { executed: true, verified: true, succeeded: false, command: "npm test", folder: PROJ, observed: "the test FAILED (exit code 1); 1 error line(s) found", durationMs: 900, errors: ["not ok 2 subtracts"], summary: ["# fail 1"] } }));
  const dt = tool(db, "dev.run_task");
  check(dt.requestCheck!.ground({ folder: PROJ, task: "test" }, `Run the tests in ${PROJ}`).status === "grounded" &&
        dt.requestCheck!.ground({ folder: PROJ, task: "build" }, `Run the tests in ${PROJ}`).status === "contradicted" &&
        dt.requestCheck!.ground({ folder: String.raw`C:\Windows`, task: "test" }, `Run the tests in ${PROJ}`).status === "contradicted", "D3 the model cannot change the folder or the task");
  const dout = await dt.execute({ folder: PROJ, task: "test" }, ctx);
  check(dout.ok && /FAILED/.test(dout.evidence) && /not ok 2 subtracts/.test(dout.evidence), "D4 a failing test run is reported with its errors (to explain it)", dout);
  check(JSON.stringify(db.calls.at(-1)!.args) === JSON.stringify({ folder: PROJ, task: "test" }), "D5 only the folder and the task reach the daemon (never a command)");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
