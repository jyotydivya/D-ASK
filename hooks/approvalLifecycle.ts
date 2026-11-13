// ─────────────────────────────────────────────────────────────────────────────
// Phase 7B.1a: the approval panel's state, as a pure reducer. The daemon is authoritative for every outcome; the page
// only (a) renders the exact canonical action the daemon will authorize, (b) offers one decision while the approval is
// pending, armed and unexpired, and (c) shows the terminal state the daemon reports. It never shows "approved" before
// the daemon says so, and it refuses to offer a decision on anything it cannot display faithfully.
// ─────────────────────────────────────────────────────────────────────────────

/** A click already in progress when the panel appears must not land on it (the native host also arms late). */
export const ARM_DELAY_MS = 1000;
/** How long a terminal state stays visible before the panel closes. */
export const TERMINAL_DISPLAY_MS = 5000;
/** Must match the daemon's limit. */
export const MAX_PARAMETER_CHARS = 2000;

export type TerminalState =
  | "Approved" | "Denied" | "Expired" | "Cancelled" | "InvalidatedByEmergencyStop" | "Disconnected" | "Rejected";
export type ApprovalPhase = "pending" | "submitting" | TerminalState;

const TERMINAL: readonly string[] = ["Approved", "Denied", "Expired", "Cancelled", "InvalidatedByEmergencyStop", "Disconnected", "Rejected"];
export const isTerminal = (p: string): p is TerminalState => TERMINAL.includes(p);

export interface ApprovalParameter { name: string; value: string }

export interface ApprovalView {
  approvalId: string;
  actionId: string;
  actionType: string;
  actionLabel: string;
  simulated: boolean;
  risk: string;
  reason: string;
  processName: string;
  windowTitle: string;
  processId: number;
  hwnd: number;
  parameters: ApprovalParameter[];
  /** A Desktop.* window operation the daemon says it will NOT perform (execution switched off). */
  approvalOnly: boolean;
  /** When the target process started (daemon-resolved identity), or "" if not given. */
  processStarted: string;
  /** The `text` parameter, if any: what would be entered. */
  textToEnter: string | null;
  /** P1/P2 element-bound input: one sentence saying exactly what will happen (control, point, keys or text). */
  inputSummary: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  parametersSha256: string;
  actionDigest: string;
}

export interface ApprovalUiState {
  /** Null when the request could not be displayed faithfully: no decision is offered and the approval expires. */
  view: ApprovalView | null;
  approvalId: string;
  phase: ApprovalPhase;
  /** Why the panel refuses to offer a decision, or the daemon's reason for a terminal state. */
  message: string | null;
  receivedAtMs: number;
  /** When the terminal state was reached, for auto-dismissal. */
  endedAtMs: number | null;
}

export type ApprovalEvent =
  | { kind: "request"; payload: unknown; nowMs: number }
  | { kind: "decide"; approved: boolean; nowMs: number }
  | { kind: "state"; payload: unknown; nowMs: number }
  | { kind: "stop"; nowMs: number }
  | { kind: "disconnected"; nowMs: number }
  | { kind: "tick"; nowMs: number };

const ACTION_LABELS: Record<string, string> = {
  SimulatedClick: "Click (simulated: no real input)",
  SimulatedType: "Type text (simulated: no real input)",
  SimulatedScroll: "Scroll (simulated: no real input)",
  SimulatedObservation: "Observe the screen (simulated)",
  // Phase 7B.2: window operations on a daemon-verified window. Approval only in this version: never performed.
  "Desktop.FocusWindow": "Bring a window to the front (focus)",
  "Desktop.SetWindowState": "Change a window's state (minimize / maximize / restore)",
  // P1 / P2: element-bound input, performed once after approval and verified.
  "Desktop.ClickElement": "Click one control once (mouse, left button)",
  "Desktop.TypeText": "Type text into one field (keyboard)",
  "Desktop.PressKeys": "Press one key combination (keyboard)",
  // Browser stage 2: D-ASK's private browser (local Chromium), performed once after approval and verified.
  "Browser.Click": "Click one element on a web page (D-ASK browser)",
  "Browser.Fill": "Fill one field on a web page (D-ASK browser)",
  // File organisation: the daemon moves exactly the listed files into subfolders of one folder (never overwriting).
  "Files.Organize": "Move files into subfolders of one folder",
  "Files.UndoOrganize": "Move files back (undo the last organisation)",
  // Workflows: a saved workflow runs on a schedule (each step still asks for approval when it would change something).
  "Workflow.Schedule": "Run a saved workflow on a schedule",
  // Plugins: approving a plugin's code (compute only, sandboxed, re-checked before every run).
  "Plugin.Install": "Install a plugin (compute only, sandboxed)",
  "Plugin.GrantPermission": "Give a plugin one extra permission",
  // Notes: the daemon writes ONE new text file in its notes folder (never overwriting), then reads it back.
  "Files.CreateNote": "Create a new note (text file)",
  // Opening one application from the daemon's fixed list (no arguments); success is only a new window seen afterwards.
  "App.Launch": "Open an application",
  // One file at a time, inside the allowed folders, never overwriting; undo is approved separately.
  "Files.Copy": "Copy a file",
  "Files.Rename": "Rename a file",
  "Files.UndoCopyRename": "Undo the last copy or rename",
};

const BROWSER_TYPES = new Set(["Browser.Click", "Browser.Fill"]);
const FILE_TYPES = new Set(["Files.Organize", "Files.UndoOrganize"]);

const COPY_RENAME_TYPES = new Set(["Files.Copy", "Files.Rename", "Files.UndoCopyRename"]);
/** Copy / rename / undo: every path and name must be given exactly (and agree with each other), or no decision is offered. */
export function copyRenameSummary(actionType: string, params: ApprovalParameter[]): { summary: string } | { error: string } {
  const p = (n: string) => params.find((x) => x.name === n)?.value;
  const abs = (s: string | undefined) => !!s && /^[A-Za-z]:\\/.test(s) && !s.includes("..");
  const plain = (s: string | undefined) => !!s && !/[\\/:*?"<>|]/.test(s) && s !== "." && s !== "..";
  if (actionType === "Files.Copy") {
    const src = p("source"), dst = p("destination"), size = p("size"), taken = p("nameTaken"), over = p("overwrite");
    if (!abs(src) || !abs(dst) || !size || !taken || !over?.startsWith("Never")) return { error: "The file to copy or where the copy goes is not given exactly." };
    if (src!.toLowerCase() === dst!.toLowerCase()) return { error: "The copy would replace the original; it will not be offered." };
    return { summary: `Copy ${src} to ${dst} (${size}), once. A new file is created; nothing is overwritten.${taken.startsWith("Yes") ? ` ${taken}.` : ""}` };
  }
  if (actionType === "Files.Rename") {
    const folder = p("folder"), from = p("from"), to = p("to"), ext = p("extensionChange"), over = p("overwrite");
    if (!abs(folder) || !plain(from) || !plain(to) || !ext || !over?.startsWith("Never") || from === to) return { error: "The file or its new name is not given exactly." };
    return { summary: `Rename ${from} to ${to} in ${folder}, once. Nothing is overwritten.${ext.startsWith("Yes") ? ` Note: ${ext}.` : ""}` };
  }
  const op = p("operation"), target = p("path"), detail = p("detail");
  if (!abs(target) || !detail || (op !== "Remove the copy D-ASK made" && op !== "Rename back")) return { error: "What would be undone is not given exactly." };
  return { summary: op === "Rename back" ? `Undo the last rename: ${detail}` : `Undo the last copy: delete ${target}, ${detail}` };
}

/** File organisation: the folder and the exact number of listed moves must agree, or no decision is offered. */
function filesSummary(actionType: string, params: ApprovalParameter[]): { summary: string } | { error: string } {
  const p = (n: string) => params.find((x) => x.name === n)?.value;
  const folder = p("folder"), count = p("moveCount"), moves = p("moves");
  if (!folder || !count || !moves || !/^\d+$/.test(count)) return { error: "The folder or the list of moves is not given exactly." };
  const lines = moves.split("\n").filter((l) => l.trim());
  if (String(lines.length) !== count || !lines.every((l) => l.includes(" → "))) return { error: "The number of moves and the list disagree; it will not be offered." };
  return actionType === "Files.Organize"
    ? { summary: `Move exactly the ${lines.length} file(s) listed below into subfolders of ${folder}, once. Nothing is overwritten or deleted.` }
    : { summary: `Move exactly the ${lines.length} file(s) listed below back into ${folder}, once. Nothing is overwritten or deleted.` };
}

/** Browser stage 2: the exact browser action in one sentence, or an error (then no decision is offered). */
function browserSummary(actionType: string, params: ApprovalParameter[]): { summary: string } | { error: string } {
  const p = (n: string) => params.find((x) => x.name === n)?.value;
  const site = p("site"), url = p("pageUrl"), role = p("elementRole"), name = p("elementName"), fp = p("elementFingerprint");
  if (!site || !url || !role || !name || !fp || !/^[0-9a-f]{64}$/.test(fp)) return { error: "The page or element this action targets is not described exactly." };
  let host = "";
  try { const u = new URL(url); host = u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return { error: "The page address cannot be read." }; }
  if (host !== site) return { error: "The site and the page address disagree; it will not be offered." };
  if (actionType === "Browser.Click") return { summary: `Click ONCE on the ${role} "${name}" on ${site}.` };
  const text = p("text"), len = p("textLength");
  if (text === undefined || len === undefined || String(text.length) !== len) return { error: "The text to fill in is not given exactly." };
  return { summary: `Fill the ${role} "${name}" on ${site} with exactly the ${text.length} character(s) shown below, once. Nothing is submitted.` };
}

const INPUT_TYPES = new Set(["Desktop.ClickElement", "Desktop.TypeText", "Desktop.PressKeys"]);

/**
 * P1/P2: the exact action in one sentence, from the digest-bound parameters only. Returns an error string when a
 * parameter needed to describe it exactly is missing or inconsistent: then no decision is offered at all.
 */
function inputSummary(actionType: string, params: ApprovalParameter[]): { summary: string } | { error: string } {
  const p = (n: string) => params.find((x) => x.name === n)?.value;
  const controlType = p("controlType"), control = p("control");
  if (!controlType || !control) return { error: "The control this input targets is not described exactly." };
  const name = p("controlName") ? ` "${p("controlName")}"` : "";
  const id = p("controlAutomationId") ? ` (#${p("controlAutomationId")})` : "";
  const target = `${controlType}${name}${id}`;
  if (actionType === "Desktop.ClickElement") {
    const point = p("point");
    if (!point || !/^-?\d+,-?\d+$/.test(point)) return { error: "The click point is not given exactly." };
    return { summary: `Left-click ONCE on ${target}, at screen point ${point}.` };
  }
  if (actionType === "Desktop.PressKeys") {
    const keys = p("keys");
    if (!keys) return { error: "The key combination is not given." };
    return { summary: `Press ${keys} ONCE while ${target} has keyboard focus.` };
  }
  const text = p("text"), len = p("textLength");
  if (text === undefined || len === undefined || String(text.length) !== len) return { error: "The text to type is not given exactly." };
  return { summary: `Type exactly the ${text.length} character(s) shown below into ${target}, once.` };
}

const SECRET_NAME = /pass(word|wd|phrase)?|secret|token|api[_.-]?key|credential|\bpin\b|otp|private[_.-]?key/i;
// Control characters other than line breaks and tabs, and bidirectional overrides/isolates (text that reads differently).
const UNDISPLAYABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Builds the view from the daemon's request. Everything shown comes from `canonicalAction`, the exact bytes the daemon
 * hashed; the outer fields must agree with it. Returns an error instead of a view if anything cannot be shown exactly.
 */
export function parseApprovalRequest(payload: unknown): { view: ApprovalView } | { error: string; approvalId: string } {
  const p = obj(payload);
  const approvalId = str(p?.approvalId) ?? "";
  const fail = (error: string) => ({ error, approvalId });
  if (!p || !approvalId) return fail("The approval request is malformed.");
  const canonical = str(p.canonicalAction);
  const digest = str(p.actionDigest);
  if (!canonical || !digest) return fail("The daemon did not include the exact action, so it cannot be shown or approved.");

  let a: Json | null;
  try { a = obj(JSON.parse(canonical)); } catch { a = null; }
  if (!a || a.schema !== "dask.approval.action.v1") return fail("The exact action could not be read.");
  if (a.approvalId !== approvalId || a.actionId !== p.actionId || a.actionType !== p.actionType) {
    return fail("The request and its exact action disagree; it will not be offered.");
  }

  const rawParams = obj(a.parameters);
  if (!rawParams) return fail("The action's parameters could not be read.");
  const parameters: ApprovalParameter[] = [];
  for (const [name, value] of Object.entries(rawParams)) {
    if (typeof value !== "string") return fail(`Parameter "${name}" is not text and cannot be shown exactly.`);
    if (SECRET_NAME.test(name)) return fail(`Parameter "${name}" looks like a secret; it is never shown or approved.`);
    if (value.length > MAX_PARAMETER_CHARS || UNDISPLAYABLE.test(value) || UNDISPLAYABLE.test(name)) {
      return fail(`Parameter "${name}" cannot be shown exactly.`);
    }
    parameters.push({ name, value });
  }
  parameters.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  const t = obj(a.target) ?? {};
  const actionType = String(a.actionType);
  const expiresAtMs = Date.parse(String(a.expiresAtUtc));
  const createdAtMs = Date.parse(String(a.createdAtUtc));
  if (!Number.isFinite(expiresAtMs)) return fail("The approval has no valid expiry.");
  let summary: string | null = null;
  if (INPUT_TYPES.has(actionType)) {
    const s = inputSummary(actionType, parameters);
    if ("error" in s) return fail(s.error);
    summary = s.summary;
  } else if (BROWSER_TYPES.has(actionType)) {
    const s = browserSummary(actionType, parameters);
    if ("error" in s) return fail(s.error);
    summary = s.summary;
  } else if (actionType === "Plugin.Install") {
    const p = (n: string) => parameters.find((x) => x.name === n)?.value;
    const tools = (p("tools") ?? "").split("\n").filter((l) => l.trim());
    if (!p("plugin") || !p("files") || !(p("permissions") ?? "").startsWith("compute only") || String(tools.length) !== p("toolCount"))
      return fail("The plugin, its tools or its permissions are not given exactly; it will not be offered.");
    summary = `Install the plugin ${p("plugin")} with the ${tools.length} tool(s) listed below. ${p("permissions")}.`;
  } else if (actionType === "Plugin.GrantPermission") {
    const p = (n: string) => parameters.find((x) => x.name === n)?.value;
    const perm = p("permission") ?? "";
    // Exactly one known permission, named with the plugin and what it allows; anything else is not offered for a decision.
    if (!p("plugin") || !["files.read", "memory.read"].includes(perm) || !p("allows") || !p("currently") || !p("enforcement"))
      return fail("The plugin, the permission or what it allows are not given exactly; it will not be offered.");
    summary = `Give the plugin ${p("plugin")} the ${perm} permission: it will be able to ${p("allows")}. D-ASK checks this every time the plugin uses it, and you can take it away again at any time.`;
  } else if (actionType === "Workflow.Schedule") {
    const p = (n: string) => parameters.find((x) => x.name === n)?.value;
    const steps = (p("steps") ?? "").split("\n").filter((l) => l.trim());
    if (!p("workflow") || !p("when") || !p("conditions") || String(steps.length) !== p("stepCount") || !steps.every((l, i) => l.startsWith(`${i + 1}. `)))
      return fail("The workflow, its steps or its timing are not given exactly; it will not be offered.");
    summary = `Run the workflow "${p("workflow")}" ${p("when")}: the ${steps.length} step(s) listed below, in order. ${p("conditions")}`;
  } else if (actionType === "Files.CreateNote") {
    const p = (n: string) => parameters.find((x) => x.name === n)?.value;
    const title = p("title"), file = p("file"), folder = p("folder"), text = p("text"), len = p("textLength");
    if (!title || !file || !folder || text === undefined || len === undefined || String(text.length) !== len)
      return fail("The note's title, file or text is not given exactly; it will not be offered.");
    const sep = file.lastIndexOf("\\");
    if (sep < 0 || file.slice(0, sep).toLowerCase() !== folder.toLowerCase() || file.slice(sep + 1) !== `${title}.txt`)
      return fail("The note's file and its title or folder disagree; it will not be offered.");
    summary = `Create the new note ${title}.txt in ${folder} containing exactly the ${text.length} character(s) shown below, once. Nothing is overwritten.`;
  } else if (actionType === "App.Launch") {
    const p = (n: string) => parameters.find((x) => x.name === n)?.value;
    const operation = p("operation"), app = p("application"), exe = p("executable"), args = p("arguments");
    if (!operation || !app || !exe || args !== "none" || !operation.startsWith("Open ") || !exe.toLowerCase().endsWith(`\\${app.toLowerCase()}`))
      return fail("The application, its file or its (empty) arguments are not given exactly; it will not be offered.");
    summary = `Open ${app} (${exe}) once, with no arguments. A new window should appear; nothing is typed, saved or changed by opening it.`;
  } else if (FILE_TYPES.has(actionType)) {
    const s = filesSummary(actionType, parameters);
    if ("error" in s) return fail(s.error);
    summary = s.summary;
  } else if (COPY_RENAME_TYPES.has(actionType)) {
    const s = copyRenameSummary(actionType, parameters);
    if ("error" in s) return fail(s.error);
    summary = s.summary;
  }
  const display = [str(t.processName), str(t.windowTitle), str(a.reason)];
  if (display.some((s) => s !== null && UNDISPLAYABLE.test(s))) return fail("The target cannot be shown exactly.");

  return {
    view: {
      approvalId,
      actionId: String(a.actionId),
      actionType,
      actionLabel: ACTION_LABELS[actionType] ?? actionType,
      simulated: actionType.startsWith("Simulated"),
      // From the daemon's own "execution" parameter (bound into the digest): approval-only exactly when it says so.
      approvalOnly: actionType.startsWith("Desktop.") && (parameters.find((x) => x.name === "execution")?.value ?? "").startsWith("Not performed"),
      processStarted: str(t.processCreationTime) ?? "",
      risk: str(a.riskLevel) ?? "Unknown",
      reason: str(a.reason) ?? "",
      processName: str(t.processName) ?? "",
      windowTitle: str(t.windowTitle) ?? "",
      processId: typeof t.processId === "number" ? t.processId : 0,
      hwnd: typeof t.hwnd === "number" ? t.hwnd : 0,
      parameters,
      textToEnter: parameters.find((x) => x.name === "text")?.value ?? null,
      inputSummary: summary,
      createdAtMs,
      expiresAtMs,
      parametersSha256: str(a.parametersSha256) ?? "",
      actionDigest: digest,
    },
  };
}

export function canDecide(s: ApprovalUiState | null, nowMs: number): boolean {
  return !!s && !!s.view && s.phase === "pending" && nowMs >= s.receivedAtMs + ARM_DELAY_MS && nowMs < s.view.expiresAtMs;
}

/** The message to send for a decision. Only valid when `canDecide`. */
export function decisionMessage(s: ApprovalUiState, approved: boolean) {
  const v = s.view!;
  return {
    type: "ActionApprovalDecision",
    payload: {
      approval_id: v.approvalId,
      action_id: v.actionId,
      action_type: v.actionType,
      parameters_sha256: v.parametersSha256,
      action_digest: v.actionDigest,
      approved,
      ...(approved ? {} : { reason: "Declined by user" }),
    },
  };
}

const end = (s: ApprovalUiState, phase: TerminalState, message: string | null, nowMs: number): ApprovalUiState =>
  isTerminal(s.phase) ? s : { ...s, phase, message, endedAtMs: nowMs };

export function reduce(s: ApprovalUiState | null, e: ApprovalEvent): ApprovalUiState | null {
  switch (e.kind) {
    case "request": {
      const parsed = parseApprovalRequest(e.payload);
      if ("view" in parsed) {
        return { view: parsed.view, approvalId: parsed.view.approvalId, phase: "pending", message: null, receivedAtMs: e.nowMs, endedAtMs: null };
      }
      // Shown, but with no way to approve: the daemon will expire it.
      return { view: null, approvalId: parsed.approvalId, phase: "pending", message: parsed.error, receivedAtMs: e.nowMs, endedAtMs: null };
    }
    case "decide":
      return s && canDecide(s, e.nowMs) ? { ...s, phase: "submitting" } : s;
    case "state": {
      const n = obj(e.payload);
      if (!s || !n || n.approvalId !== s.approvalId) return s;
      const state = String(n.state);
      const reason = str(n.reason);
      if (n.decisionAccepted === false) {
        const phase = isTerminal(state) ? state : "Rejected";
        return { ...s, phase, message: `Your decision was not accepted: ${describe(phase)}.`, endedAtMs: s.endedAtMs ?? e.nowMs };
      }
      return isTerminal(state) ? end(s, state, reason, e.nowMs) : s;
    }
    case "stop":
      return s ? end(s, "InvalidatedByEmergencyStop", "Emergency Stop withdrew this approval.", e.nowMs) : s;
    case "disconnected":
      return s ? end(s, "Disconnected", "The connection to the daemon was lost; nothing was authorized.", e.nowMs) : s;
    case "tick": {
      if (!s) return s;
      if (s.endedAtMs !== null && e.nowMs - s.endedAtMs >= TERMINAL_DISPLAY_MS) return null;
      const expires = s.view?.expiresAtMs ?? s.receivedAtMs + 30_000;
      if ((s.phase === "pending" || s.phase === "submitting") && e.nowMs >= expires) {
        return end(s, "Expired", "The approval expired before a decision.", e.nowMs);
      }
      return s;
    }
  }
}

export function describe(phase: ApprovalPhase): string {
  switch (phase) {
    case "pending": return "waiting for your decision";
    case "submitting": return "waiting for the daemon to confirm";
    case "Approved": return "approved by you and authorized by the daemon for this single action";
    case "Denied": return "denied";
    case "Expired": return "expired";
    case "Cancelled": return "cancelled";
    case "InvalidatedByEmergencyStop": return "withdrawn by Emergency Stop";
    case "Disconnected": return "withdrawn because the HUD connection or liveness was lost";
    case "Rejected": return "refused by the daemon";
  }
}
