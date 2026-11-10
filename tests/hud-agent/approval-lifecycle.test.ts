/**
 * Phase 7B.1a: the approval panel's lifecycle and presentation rules (pure reducer, no DOM).
 * Run with: npx tsx tests/hud-agent/approval-lifecycle.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  ARM_DELAY_MS, TERMINAL_DISPLAY_MS, canDecide, decisionMessage, parseApprovalRequest, reduce,
  type ApprovalUiState,
} from "../../hooks/approvalLifecycle";

let passed = 0;
let failed = 0;
function check(ok: unknown, name: string, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

const T0 = Date.parse("2026-11-08T12:00:00Z");

function request(over: { params?: Record<string, unknown>; canonical?: string | null; digest?: string | null; outer?: Record<string, unknown>; expiresInMs?: number; target?: Record<string, unknown> } = {}) {
  const action = {
    schema: "dask.approval.action.v1",
    approvalId: "ap1", actionId: "act1", actionType: "SimulatedType",
    parameters: over.params ?? { text: "hello world", field: "Search box" },
    parametersSha256: "phash",
    target: over.target ?? { processName: "fixture.exe", windowTitle: "Fixture window", hwnd: 4660, processId: 4321, processCreationTime: null },
    sessionId: "s1", stopGeneration: 1, riskLevel: "Elevated", reason: "Type into the fixture",
    createdAtUtc: new Date(T0).toISOString(), expiresAtUtc: new Date(T0 + (over.expiresInMs ?? 30_000)).toISOString(),
  };
  return {
    approvalId: "ap1", actionId: "act1", actionType: "SimulatedType", parametersSha256: "phash",
    actionParameters: { text: "hello world" },
    canonicalAction: over.canonical === undefined ? JSON.stringify(action) : over.canonical,
    actionDigest: over.digest === undefined ? "digest123" : over.digest,
    ...over.outer,
  };
}

const start = (r = request()) => reduce(null, { kind: "request", payload: r, nowMs: T0 })!;

console.log("\n[presentation] the panel shows the exact canonical action");
{
  const s = start();
  const v = s.view!;
  check(v && v.actionType === "SimulatedType" && v.processName === "fixture.exe" && v.windowTitle === "Fixture window", "action, application and window come from the canonical action");
  check(v.processId === 4321 && v.hwnd === 4660, "target process identity is shown");
  check(JSON.stringify(v.parameters) === JSON.stringify([{ name: "field", value: "Search box" }, { name: "text", value: "hello world" }]), "every parameter, in full, in a stable order", v.parameters);
  check(v.textToEnter === "hello world", "the text to be entered is shown on its own");
  check(v.expiresAtMs === T0 + 30_000 && v.risk === "Elevated" && v.reason === "Type into the fixture", "expiry, risk and the requested operation are shown");
  check(v.simulated && /no real input/.test(v.actionLabel), "a simulated action is labelled as performing no real input");
  check(v.actionDigest === "digest123", "the digest is kept for the echo, not used as the description");

  const long = "x".repeat(2000);
  check(start(request({ params: { text: long } })).view?.textToEnter === long, "a 2,000-character value is shown untruncated");
}

console.log("\n[refusal] anything that cannot be shown exactly is never offered for approval");
{
  const cases: [string, ReturnType<typeof request>][] = [
    ["no canonical action", request({ canonical: null })],
    ["no digest", request({ digest: null })],
    ["unparseable canonical action", request({ canonical: "{not json" })],
    ["wrong schema", request({ canonical: JSON.stringify({ schema: "other" }) })],
    ["outer fields disagree with the canonical action", request({ outer: { actionType: "SimulatedClick" } })],
    ["a secret-named parameter", request({ params: { password: "hunter2" } })],
    ["a non-text parameter", request({ params: { count: 3 } })],
    ["a control character", request({ params: { text: "a\u0007b" } })],
    ["a right-to-left override", request({ params: { text: "abc‮dcba" } })],
    ["an oversized value", request({ params: { text: "x".repeat(2001) } })],
    ["an undisplayable title", request({ target: { processName: "f.exe", windowTitle: "a‮b" } })],
  ];
  for (const [name, r] of cases) {
    const s = start(r);
    check(s.view === null && !!s.message && !canDecide(s, T0 + ARM_DELAY_MS + 1), `${name}: refused, no decision possible`, s.message);
  }
  const p = parseApprovalRequest(request({ params: { password: "hunter2" } }));
  check("error" in p && !JSON.stringify(p).includes("hunter2"), "a refused secret value is not echoed into the message");
}

console.log("\n[lifecycle] one decision, only while pending, armed and unexpired");
{
  const s = start();
  check(!canDecide(s, T0 + ARM_DELAY_MS - 1), "not armed immediately: a click already in flight is ignored");
  check(canDecide(s, T0 + ARM_DELAY_MS), "armed after the delay");
  check(!canDecide(s, T0 + 30_000), "not after expiry");

  const early = reduce(s, { kind: "decide", approved: true, nowMs: T0 + 10 })!;
  check(early.phase === "pending", "a decision before arming is ignored");

  const sub = reduce(s, { kind: "decide", approved: true, nowMs: T0 + 2000 })!;
  check(sub.phase === "submitting", "a decision moves to submitting, not to approved");
  check(!canDecide(sub, T0 + 2100), "no second decision while waiting for the daemon");
  const msg = decisionMessage(s, true);
  check(msg.type === "ActionApprovalDecision" && msg.payload.action_digest === "digest123" && msg.payload.approval_id === "ap1", "the decision echoes the daemon's digest", msg);

  const ok = reduce(sub, { kind: "state", payload: { approvalId: "ap1", state: "Approved" }, nowMs: T0 + 2200 })!;
  check(ok.phase === "Approved", "approved only when the daemon confirms");
  const other = reduce(sub, { kind: "state", payload: { approvalId: "other", state: "Approved" }, nowMs: T0 + 2200 })!;
  check(other.phase === "submitting", "a state for another approval changes nothing");
  check(reduce(ok, { kind: "tick", nowMs: T0 + 2200 + TERMINAL_DISPLAY_MS }) === null, "the terminal state closes the panel after it was shown");
}

console.log("\n[terminal states] every daemon state ends the panel and disables decisions");
for (const state of ["Approved", "Denied", "Expired", "Cancelled", "InvalidatedByEmergencyStop", "Disconnected", "Rejected"]) {
  const s = reduce(start(), { kind: "state", payload: { approvalId: "ap1", state, reason: "r" }, nowMs: T0 + 1500 })!;
  check(s.phase === state && !canDecide(s, T0 + 2000) && reduce(s, { kind: "decide", approved: true, nowMs: T0 + 2000 })!.phase === state, `${state}: terminal, not clickable`);
}
{
  const late = reduce(reduce(start(), { kind: "decide", approved: true, nowMs: T0 + 2000 }), { kind: "state", payload: { approvalId: "ap1", state: "Expired", decisionAccepted: false }, nowMs: T0 + 2100 })!;
  check(late.phase === "Expired" && /not accepted/.test(late.message ?? ""), "a late decision is shown as not accepted", late);
  const stop = reduce(start(), { kind: "stop", nowMs: T0 + 1500 })!;
  check(stop.phase === "InvalidatedByEmergencyStop" && !canDecide(stop, T0 + 2000), "Emergency Stop withdraws the approval locally at once");
  const disc = reduce(reduce(start(), { kind: "decide", approved: true, nowMs: T0 + 2000 }), { kind: "disconnected", nowMs: T0 + 2100 })!;
  check(disc.phase === "Disconnected" && !/approved/i.test(disc.phase), "disconnect while submitting never implies success");
  const expired = reduce(start(), { kind: "tick", nowMs: T0 + 30_000 })!;
  check(expired.phase === "Expired" && !canDecide(expired, T0 + 30_000), "the panel shows expiry from the daemon's expiry time");
  const after = reduce(stop, { kind: "state", payload: { approvalId: "ap1", state: "Approved" }, nowMs: T0 + 2200 })!;
  check(after.phase === "InvalidatedByEmergencyStop", "a terminal state is never replaced by a later one");
}

console.log("\n[source] the old modal and its local 30-second auto-deny are gone; the panel is the only approval UI");
{
  const orb = fs.readFileSync(path.join(__dirname, "..", "..", "components", "JarvisOrb.tsx"), "utf8");
  const surface = fs.readFileSync(path.join(__dirname, "..", "..", "components", "ApprovalSurface.tsx"), "utf8");
  check(!/pendingApproval|approvalCountdown|ActionApprovalDecision/.test(orb), "JarvisOrb has no approval state or decision code of its own");
  check(/<ApprovalSurface \/>/.test(orb), "JarvisOrb mounts the approval panel");
  check(/data-hud-approval/.test(surface) && /ApprovalSurface/.test(surface) && /type: "ApprovalSurface"/.test(surface), "the panel reports its own region to the host");
  check(!/type: "Approval"[,\s}]/.test(orb + surface), "the obsolete Approval message is never sent");
}

// ── P1 / P2: element-bound input approvals ───────────────────────────────────
console.log("\n[P1/P2] Input approval cards");
{
  const inputReq = (actionType: string, params: Record<string, string>) => {
    const action = {
      schema: "dask.approval.action.v1", approvalId: "ap9", actionId: "act9", actionType, parameters: params, parametersSha256: "phash",
      target: { processName: "powershell.exe", windowTitle: "DASK Input Fixture", hwnd: 4660, processId: 4321, processCreationTime: null },
      sessionId: "s1", stopGeneration: 1, riskLevel: "Elevated", reason: "D-ASK asks to click a control of powershell.exe.",
      createdAtUtc: new Date(T0).toISOString(), expiresAtUtc: new Date(T0 + 30_000).toISOString(),
    };
    return { approvalId: "ap9", actionId: "act9", actionType, parametersSha256: "phash", actionParameters: params,
      canonicalAction: JSON.stringify(action), actionDigest: "digest-input" };
  };
  const common = { control: "Button #go", controlType: "Button", controlAutomationId: "go", controlName: "Go", inputPolicy: "mouse", execution: "Performed once…" };
  const click = parseApprovalRequest(inputReq("Desktop.ClickElement", { ...common, point: "160,165" }));
  check("view" in click && click.view.actionLabel.startsWith("Click one control once") && click.view.inputSummary === 'Left-click ONCE on Button "Go" (#go), at screen point 160,165.' && !click.view.approvalOnly,
    "P1a click card: label and an exact 'what will happen' (control, id, point)", click);
  check("error" in parseApprovalRequest(inputReq("Desktop.ClickElement", { ...common })), "P1b click without a point -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Desktop.ClickElement", { ...common, point: "160,165", control: "" })) ||
        "error" in parseApprovalRequest(inputReq("Desktop.ClickElement", { point: "160,165", controlType: "Button" })), "P1c click without the control -> no decision offered");

  const editCommon = { control: "Edit #notes", controlType: "Edit", controlAutomationId: "notes", controlName: "", inputPolicy: "keyboard", execution: "Performed once…" };
  const typed = parseApprovalRequest(inputReq("Desktop.TypeText", { ...editCommon, text: "hello d-ask", textLength: "11" }));
  check("view" in typed && typed.view.textToEnter === "hello d-ask" && typed.view.inputSummary === "Type exactly the 11 character(s) shown below into Edit (#notes), once.",
    "P2a type card: the complete text is shown, with its exact length", typed);
  check("error" in parseApprovalRequest(inputReq("Desktop.TypeText", { ...editCommon, text: "hello d-ask", textLength: "5" })), "P2b text length that does not match -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Desktop.TypeText", { ...editCommon, textLength: "5" })), "P2c no text -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Desktop.TypeText", { ...editCommon, text: "hello d-ask", textLength: "11", password: "x" })),
    "P2d a secret-named parameter still refuses the whole card (no field content is ever shown)");
  const keys = parseApprovalRequest(inputReq("Desktop.PressKeys", { ...editCommon, keys: "Ctrl+A" }));
  check("view" in keys && keys.view.inputSummary === "Press Ctrl+A ONCE while Edit (#notes) has keyboard focus.", "P2e key card: the exact chord and control", keys);
  check("error" in parseApprovalRequest(inputReq("Desktop.PressKeys", { ...editCommon })), "P2f no chord -> no decision offered");

  // The lifecycle is unchanged for input: one decision, expiry and disconnect rules apply exactly as for other approvals.
  const s0 = reduce(null, { kind: "request", payload: inputReq("Desktop.TypeText", { ...editCommon, text: "abc", textLength: "3" }), nowMs: T0 })!;
  check(s0.phase === "pending" && canDecide(s0, T0 + 1000), "P2g a valid input card is decidable while pending");
  const sub = reduce(s0, { kind: "decide", approved: true, nowMs: T0 + 1000 })!;
  check(!canDecide(sub, T0 + 1100), "P2h after a decision no second decision is possible");
  check(!canDecide(reduce(null, { kind: "request", payload: inputReq("Desktop.TypeText", { ...editCommon, text: "abc", textLength: "3" }), nowMs: T0 })!, T0 + 31_000),
    "P2i an expired input card cannot be decided");
  check(!canDecide(reduce(s0, { kind: "disconnected", nowMs: T0 + 500 }), T0 + 600), "P2j a disconnected HUD cannot decide an input card");
  check(!canDecide(reduce(s0, { kind: "stop", nowMs: T0 + 500 }), T0 + 600), "P2k Emergency Stop ends a pending input card");

  // Browser stage 2: the browser card names the site, the element and (for a fill) the complete text.
  const fp = "a".repeat(64);
  const bCommon = { site: "127.0.0.1:8080", pageUrl: "http://127.0.0.1:8080/form", pageTitle: "Fixture form", elementRole: "button", elementName: "Submit", elementTag: "button", elementFingerprint: fp, execution: "Performed once…" };
  const bc = parseApprovalRequest(inputReq("Browser.Click", bCommon));
  check("view" in bc && bc.view.inputSummary === 'Click ONCE on the button "Submit" on 127.0.0.1:8080.' && bc.view.actionLabel.startsWith("Click one element on a web page") && !bc.view.approvalOnly,
    "B1 browser click card: site and element, exactly", bc);
  const bfCommon = { ...bCommon, elementRole: "textbox", elementName: "Email", elementTag: "input" };
  const bf = parseApprovalRequest(inputReq("Browser.Fill", { ...bfCommon, text: "me@example.com", textLength: "14" }));
  check("view" in bf && bf.view.textToEnter === "me@example.com" && /exactly the 14 character\(s\).*Nothing is submitted/.test(bf.view.inputSummary ?? ""), "B2 browser fill card: the complete text and its length", bf);
  check("error" in parseApprovalRequest(inputReq("Browser.Fill", { ...bfCommon, text: "me@example.com", textLength: "3" })), "B3 fill text length mismatch -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Browser.Click", { ...bCommon, site: "evil.com" })), "B4 site and page address disagree -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Browser.Click", { ...bCommon, elementName: "" })) && "error" in parseApprovalRequest(inputReq("Browser.Click", { ...bCommon, elementFingerprint: "x" })),
    "B5 element not described exactly -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Browser.Fill", { ...bfCommon, text: "x", textLength: "1", password: "x" })), "B6 a secret-named parameter refuses the whole browser card");

  // File organisation: the card names the folder and lists every move; the count must match the list.
  const fCommon = { folder: "C:\\Users\\me\\Downloads", moveCount: "2", moves: "report.pdf → Documents\\\nphoto.jpg → Images\\", newSubfolders: "Documents, Images",
    overwrite: "Never", execution: "Performed once…" };
  const fo = parseApprovalRequest(inputReq("Files.Organize", fCommon));
  check("view" in fo && fo.view.actionLabel === "Move files into subfolders of one folder" && /exactly the 2 file\(s\) listed below into subfolders of C:\\Users\\me\\Downloads.*Nothing is overwritten/.test(fo.view.inputSummary ?? "")
    && !fo.view.approvalOnly, "F1 organise card: the folder and the exact number of listed moves", fo);
  check("error" in parseApprovalRequest(inputReq("Files.Organize", { ...fCommon, moveCount: "3" })), "F2 move count and list disagree -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Files.Organize", { ...fCommon, moves: "" })) && "error" in parseApprovalRequest(inputReq("Files.UndoOrganize", { ...fCommon, folder: "" })),
    "F3 missing folder or moves -> no decision offered");
  const fu = parseApprovalRequest(inputReq("Files.UndoOrganize", { ...fCommon, moves: "Documents\\report.pdf → (back to Downloads)\nImages\\photo.jpg → (back to Downloads)" }));
  check("view" in fu && /back into C:\\Users\\me\\Downloads/.test(fu.view.inputSummary ?? ""), "F4 undo card: the files listed go back", fu);

  const wCommon = { workflow: "morning", when: "every day at 09:00 (this computer's local time)", firstRun: "2026-11-11 09:00", stepCount: "2",
    steps: "1. Summarize docs/notes.md\n2. What time is it?", conditions: "Runs only while the HUD is connected …", execution: "Only the schedule is stored now…" };
  const ws = parseApprovalRequest(inputReq("Workflow.Schedule", wCommon));
  check("view" in ws && ws.view.actionLabel === "Run a saved workflow on a schedule" && /"morning" every day at 09:00.*the 2 step\(s\) listed below/.test(ws.view.inputSummary ?? ""), "W1 schedule card: workflow, timing and every step", ws);
  check("error" in parseApprovalRequest(inputReq("Workflow.Schedule", { ...wCommon, stepCount: "3" })) && "error" in parseApprovalRequest(inputReq("Workflow.Schedule", { ...wCommon, when: "" })),
    "W2 step count or timing missing/inconsistent -> no decision offered");

  const pCommon = { plugin: "Text tools (text_tools) 1.0.0", tools: "word_count: Count the words\ntitle_case: Title Case", toolCount: "2",
    permissions: "compute only: no files, no network, no programs, no other processes (enforced by D-ASK's sandbox)", files: "2 file(s), 1350 bytes; manifest SHA-256 ab", execution: "Only the approval is recorded now…" };
  const pi = parseApprovalRequest(inputReq("Plugin.Install", pCommon));
  check("view" in pi && pi.view.actionLabel.startsWith("Install a plugin") && /text_tools.*the 2 tool\(s\).*compute only/.test(pi.view.inputSummary ?? ""), "PL1 plugin card: plugin, tools, compute only", pi);
  check("error" in parseApprovalRequest(inputReq("Plugin.Install", { ...pCommon, toolCount: "1" })) && "error" in parseApprovalRequest(inputReq("Plugin.Install", { ...pCommon, permissions: "network" })),
    "PL2 tool count mismatch or any permission other than compute -> no decision offered");

  // Notes: the card names the exact file and shows the exact text; title, file, folder and length must agree.
  const noteText = 'She said "yes" — Friday.';
  const nCommon = { title: "Meeting", file: "C:\\Users\\me\\Documents\\D-ASK Notes\\Meeting.txt", folder: "C:\\Users\\me\\Documents\\D-ASK Notes",
    text: noteText, textLength: String(noteText.length), format: "Plain text (UTF-8)…", overwrite: "Never…", execution: "Written once…" };
  const nc = parseApprovalRequest(inputReq("Files.CreateNote", nCommon));
  check("view" in nc && nc.view.actionLabel === "Create a new note (text file)" && nc.view.textToEnter === noteText
    && /new note Meeting\.txt in C:\\Users\\me\\Documents\\D-ASK Notes containing exactly the 24 character\(s\).*Nothing is overwritten/.test(nc.view.inputSummary ?? ""),
    "N1 note card: exact file, folder and text (quotes kept)", nc);
  check("error" in parseApprovalRequest(inputReq("Files.CreateNote", { ...nCommon, textLength: "5" })) && "error" in parseApprovalRequest(inputReq("Files.CreateNote", { ...nCommon, title: "" })),
    "N2 text length mismatch or missing title -> no decision offered");
  check("error" in parseApprovalRequest(inputReq("Files.CreateNote", { ...nCommon, file: "C:\\Windows\\Meeting.txt" })) && "error" in parseApprovalRequest(inputReq("Files.CreateNote", { ...nCommon, file: "C:\\Users\\me\\Documents\\D-ASK Notes\\Other.txt" })),
    "N3 a file outside the folder, or not named after the title -> no decision offered");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
