// ─────────────────────────────────────────────────────────────────────────────
// Phase 7B.1b: read-only desktop tools. The tools only ask the daemon; every Windows API call, every identity and
// every validation happens there. The agent can name a window (an application or part of a title taken from the
// user's request) but can never supply a window handle, a process id, a session or an approval. Nothing here can
// click, type, focus, resize, launch or close anything.
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import { requestedBrowserActions } from "./browserActions";
import { systemRequest } from "./systemAdmin";
import { chromeRequest } from "./chrome";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolOutcome, ToolRequestCheck, ToolSpec } from "../types";

/** The daemon's answer to a call (agent/host/desktopBridge.ts carries it over protocol v2). */
export interface DesktopReply {
  status: "ok" | "error" | "cancelled";
  result?: any;
  error?: { code: string; message: string; candidates?: unknown };
}

/** How the tools reach the daemon. Absent: the tools are not registered at all. */
export interface DesktopBridge {
  readonly available: boolean;
  /** Whether the daemon offered this tool in hello. Absent (test fakes): every tool is treated as offered. */
  offers?(tool: string): boolean;
  call(taskId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<DesktopReply>;
}

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });

// ── request understanding ──────────────────────────────────────────────────

/** Application names a request may use, and the process image the daemon matches. Conservative on purpose. */
const APPS: [RegExp, string][] = [
  [/\bnotepad\b/i, "notepad.exe"],
  [/\bcalculator\b/i, "CalculatorApp.exe"],
  [/\b(google\s+)?chrome\b/i, "chrome.exe"],
  [/\bmicrosoft\s+edge\b|\bedge\s+(browser|window)\b/i, "msedge.exe"],
  [/\bfirefox\b/i, "firefox.exe"],
  [/\bfile\s+explorer\b|\bexplorer\s+window\b/i, "explorer.exe"],
  [/\b(vs\s?code|visual\s+studio\s+code)\b/i, "Code.exe"],
  [/\bmicrosoft\s+word\b|\bword\s+(window|document|app)\b/i, "WINWORD.EXE"],
  [/\b(microsoft\s+)?excel\b/i, "EXCEL.EXE"],
  [/\b(microsoft\s+)?powerpoint\b/i, "POWERPNT.EXE"],
  [/\b(microsoft\s+)?outlook\b/i, "OUTLOOK.EXE"],
  [/\b(windows\s+)?terminal\b/i, "WindowsTerminal.exe"],
  [/\bpowershell\b/i, "powershell.exe"],
  [/\btask\s+manager\b/i, "Taskmgr.exe"],
  [/\bms\s?paint\b|\bpaint\s+(window|app)\b/i, "mspaint.exe"],
];

/** The process the request names, if exactly one: an explicit "x.exe", or one known application name. */
export function requestedProcess(objective: string): string | null {
  const exe = /\b([A-Za-z0-9][A-Za-z0-9._-]{0,60}\.exe)\b/i.exec(objective);
  if (exe) return exe[1]!.trim();
  const hits = APPS.filter(([re]) => re.test(objective)).map(([, p]) => p);
  return hits.length === 1 ? hits[0]! : null;
}

/** A window title fragment the request quotes ("…", '…' or “…”), if any. */
export function requestedTitle(objective: string): string | null {
  // A quote introduced as the window's title wins: input requests also quote the text to type and control names.
  const titled = /\b(?:window|app|application)\s+(?:titled|called|named)\s+["“'‘]([^"”'’]{2,100})["”'’]/i.exec(objective)
    ?? /\btitled\s+["“'‘]([^"”'’]{2,100})["”'’]/i.exec(objective);
  if (titled) return titled[1]!.trim();
  if (requestedInputAction(objective)) return null; // an input request must name its window explicitly ("window titled …")
  const m = /["“'‘]([^"”'’]{2,100})["”'’]/.exec(objective);
  return m ? m[1]!.trim() : null;
}

const WINDOW_NOUN = /\b(windows?|apps?|applications?|programs?)\b/i;
const LIST_INTENT =
  /\b(what|which|list|show|tell\s+me|any|how\s+many)\b[^.?!]*\b(windows?|apps?|applications?|programs?)\b[^.?!]*\b(open|running|opened)\b|\b(open|running)\s+(windows|apps|applications|programs)\b|\blist\s+(the\s+|all\s+|my\s+)?(open\s+|running\s+)?(windows|apps|applications|programs)\b|\bis\b[^.?!]*\b(open|running)\b/i;
const INSPECT_INTENT =
  /\b(inspect|examine|describe|analy[sz]e)\b|\bwhat('?s| is)\s+(in|on|inside)\b|\bwhat\s+(controls|buttons|elements|fields|menus|items)\b|\b(which|list|show(\s+me)?)\s+(the\s+)?(controls|buttons|elements|fields|menus)\b|\bui\s+(tree|elements)\b/i;
const UNNAMED_WINDOW = /\b(this|that|the|my|current|active|focused)\s+(window|app|application|program)\b/i;

/** Vision: read the TEXT a named window shows (offline OCR in the daemon), as opposed to its UI tree (inspect). */
const READ_TEXT_INTENT = /\b(read|ocr|extract|transcribe)\b[^.?!]*\b(text|words|writing|contents?)\b|\bwhat\s+(does|do)\b[^.?!]*\bsays?\b|\bocr\b|\btext\s+(in|on|of)\s+(the\s+)?(window|screen)\b/i;
export const isReadTextRequest = (o: string) => READ_TEXT_INTENT.test(o) && !requestedWindowAction(o) && !actuationRefusal(o) && (requestedProcess(o) !== null || requestedTitle(o) !== null);
export const isInspectRequest = (o: string) => !actuationRefusal(o) && !requestedWindowAction(o) && !isReadTextRequest(o) && INSPECT_INTENT.test(o) && (WINDOW_NOUN.test(o) || requestedProcess(o) !== null || requestedTitle(o) !== null);
export const isListRequest = (o: string) => LIST_INTENT.test(o) && !isInspectRequest(o) && !requestedWindowAction(o);

/** "Inspect this window", "what controls are in the window?": nothing names it, so ask (never pick one). */
export function inspectClarification(o: string): string | null {
  if (!INSPECT_INTENT.test(o)) return null;
  if (requestedProcess(o) || requestedTitle(o)) return null;
  if (!UNNAMED_WINDOW.test(o) && !WINDOW_NOUN.test(o)) return null;
  return "Which window do you mean? Name the application (for example Notepad) or quote part of the window title. I won't pick a window for you.";
}

/**
 * Requests to act on the desktop. Phase 7B.1b is read-only: these are answered with a plain refusal before planning,
 * so no tool (not even a read-only one) runs on their behalf and nothing can be presented as having been done.
 */
const ACTUATION_IMPERATIVE =
  /^\s*(please\s+|can you\s+|could you\s+)?(click|double[- ]click|right[- ]click|tap|press|type|enter|fill( in)?|close|minimi[sz]e|maximi[sz]e|restore|focus|activate|switch to|bring|launch|start|run|kill|terminate|quit|drag|scroll|select|resize|move|toggle|tick|untick)\b/i;
const ACTUATION_ANYWHERE = /\b(click|double[- ]click|right[- ]click|scroll (up|down)|type (into|in)|drag)\b/i;
export function actuationRefusal(o: string, inputOffered: (tool: string) => boolean = () => true): string | null {
  // Windows administration (2026-11-14): "kill notepad", "turn off wifi", "restart the computer in 5 minutes" belong to the system tools
  // (approved by the daemon), not refused here, but ONLY when the daemon offers that tool.
  const sys = systemRequest(o);
  if (sys && inputOffered(sys.tool)) return null;
  const chr = chromeRequest(o);
  if (chr && inputOffered(chr.tool)) return null;
  // "Open Notepad [and type …]" is an approval request (desktop.launch_app, then the guarded typing), not refused here, but ONLY
  // when the daemon offers the tools it needs. Otherwise it falls through to the refusal below, exactly as before.
  const session = appSession(o);
  if (session && inputOffered("desktop.launch_app") && (session.text === null || inputOffered("desktop.type_text"))) return null;
  if (session) return "I can't open applications or type into them in this installation (the daemon does not offer it), so I haven't done anything.";
  // P1/P2: one element-bound click, text entry or allowed key chord is an approval request, not refused here, but ONLY
  // when the daemon offers that input tool. With input switched off it is refused exactly as before (no model call).
  const steps = requestedInputActions(o);
  if (steps.length > 0 && steps.every((a) => inputOffered(a.tool))) return null;
  // Browser stage 2: a request that is entirely clicks/fills on a named web page belongs to the browser tools, which
  // answer it (or refuse it when the daemon does not offer browser actions). Nothing here can act on a web page.
  if (requestedBrowserActions(o)) return null;
  if (!ACTUATION_IMPERATIVE.test(o) && !ACTUATION_ANYWHERE.test(o)) return null;
  if (!(WINDOW_NOUN.test(o) || /\b(button|field|box|menu|tab|link|checkbox|control|icon)\b/i.test(o) || requestedProcess(o) || requestedTitle(o))) return null;
  // Phase 7B.2: focus / minimize / maximize / restore of one window are requests for approval, not refused here,
  // unless the same request also asks for something else (clicking, typing, …).
  if (!ACTUATION_ANYWHERE.test(o) && requestedWindowAction(o)) return null;
  return "I can't click, type, scroll, move, resize, close or launch anything. I can list open windows, describe a window you name, and ask your approval to focus, minimize, maximize or restore a window (each one only with your approval in the HUD).";
}

// ── Phase 7B.2: window-operation requests (approval only) ───────────────────

const WINDOW_ACTION =
  /^\s*(please\s+|can you\s+|could you\s+)?(focus( on)?|bring|switch to|activate|minimi[sz]e|maximi[sz]e|restore)\b(?!.*\b(and|then)\s+(click|type|close|press|scroll|drag|open|launch)\b)/i;

export interface WindowActionRequest { tool: "desktop.focus_window" | "desktop.set_window_state"; state: "minimize" | "maximize" | "restore" | null }

/**
 * Every window operation the request asks for, in the order asked (Phase 7B.3). Only requests that BEGIN with a window
 * operation qualify (as before). Verbs inside quoted text (a window title) are not operations. A request such as
 * "Minimize X then restore it" yields two operations; each is verified separately and in order (grounding.ts, `sequence`).
 */
const WINDOW_VERB = /\b(focus(?:\s+on)?|bring|switch\s+to|activate|minimi[sz]e|maximi[sz]e|restore)\b/gi;
const QUOTED = /["“'‘][^"”'’]{2,100}["”'’]/g;

function operationOf(verb: string): WindowActionRequest {
  const v = verb.toLowerCase();
  if (v.startsWith("minimi")) return { tool: "desktop.set_window_state", state: "minimize" };
  if (v.startsWith("maximi")) return { tool: "desktop.set_window_state", state: "maximize" };
  if (v === "restore") return { tool: "desktop.set_window_state", state: "restore" };
  return { tool: "desktop.focus_window", state: null };
}

export function requestedWindowActions(o: string): WindowActionRequest[] {
  const m = WINDOW_ACTION.exec(o);
  if (!m) return [];
  const ops = [...o.replace(QUOTED, " ").matchAll(WINDOW_VERB)].map((x) => operationOf(x[1]!));
  return ops.length > 0 ? ops : [operationOf(m[2]!)];
}

/** The FIRST window operation the request asks for, if it is one of the approval-gated ones. */
export function requestedWindowAction(o: string): WindowActionRequest | null {
  return requestedWindowActions(o)[0] ?? null;
}

/** More than one window or application named: with several operations the target of each would be a guess. */
function namesSeveralWindows(o: string): boolean {
  const quoted = new Set([...o.matchAll(QUOTED)].map((x) => x[0].slice(1, -1).trim().toLowerCase()));
  const exes = new Set([...o.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._-]{0,60}\.exe)\b/gi)].map((x) => x[1]!.toLowerCase()));
  const apps = exes.size > 0 ? exes.size : APPS.filter(([re]) => re.test(o)).length;
  return quoted.size > 1 || apps > 1;
}

/** "Minimize this window": nothing names the target, so ask. The daemon would refuse to guess anyway. */
export function windowActionClarification(o: string): string | null {
  const ops = requestedWindowActions(o);
  if (ops.length === 0 || ACTUATION_ANYWHERE.test(o)) return null;
  if (ops.length > 1 && namesSeveralWindows(o)) {
    return "Your request asks for several window operations and names more than one window. I won't guess which operation goes with which window; please ask for one window at a time.";
  }
  if (requestedProcess(o) || requestedTitle(o)) return null;
  return "Which window do you mean? Name the application (for example Notepad) or quote part of the window title. I won't pick a window for you.";
}

// ── shared ─────────────────────────────────────────────────────────────────

const VOCAB = ["what", "which", "list", "show", "tell", "me", "any", "how", "many", "windows", "window", "apps", "app",
  "applications", "application", "programs", "program", "open", "opened", "running", "currently", "now", "right",
  "desktop", "my", "all", "are", "is", "there", "on", "screen", "computer", "inspect", "examine", "describe",
  "analyse", "analyze", "controls", "control", "buttons", "button", "elements", "element", "fields", "field", "menus",
  "items", "inside", "titled", "called", "named", "title", "ui", "tree", "the"];

function appWords(objective: string): string[] {
  const words: string[] = [];
  for (const [re] of APPS) {
    const m = re.exec(objective);
    if (m) words.push(...contentWords(m[0]));
  }
  const exe = /\b([A-Za-z0-9][A-Za-z0-9._-]{0,60}\.exe)\b/i.exec(objective);
  if (exe) words.push(...contentWords(exe[1]!));
  const t = requestedTitle(objective);
  if (t) words.push(...contentWords(t));
  return words;
}

function domains(objective: string): Record<string, ArgumentDomain> {
  const p = requestedProcess(objective);
  const t = requestedTitle(objective);
  return {
    // The model never picks a window: only what the user named.
    process: p ? { kind: "enum", values: [p], optional: false } : { kind: "forbidden", reason: "the request names no application" },
    titleContains: t ? { kind: "enum", values: [t], optional: false } : { kind: "forbidden", reason: "the request quotes no window title" },
  };
}

function selectorMatches(input: { process?: string; titleContains?: string }, objective: string): GroundingVerdict {
  const p = requestedProcess(objective);
  const t = requestedTitle(objective);
  if ((input.process ?? null) !== p) return contradicted(p ? `the request names ${p}` : "the request names no application; omit process");
  if ((input.titleContains ?? null) !== t) return contradicted(t ? `the request quotes "${t}"` : "the request quotes no title; omit titleContains");
  return grounded("the window selector is taken from the request");
}

async function callDaemon(bridge: DesktopBridge, tool: string, input: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, timeoutMs: number) {
  if (!bridge.available) return { reply: null as DesktopReply | null, error: "Desktop observation is not available (the daemon did not enable protocol v2)." };
  try {
    return { reply: await bridge.call(ctx.taskId, tool, input, ctx.signal, timeoutMs), error: null };
  } catch (e) {
    return { reply: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const fmtDisplay = (d: any) => (d && typeof d.index === "number" && d.index >= 0 ? `display ${d.index + 1}${d.primary ? ", primary" : ""}` : "display unknown");

// ── desktop.list_windows ───────────────────────────────────────────────────

interface ListInput { process?: string; titleContains?: string; limit?: number }

export const listWindowsCheck: ToolRequestCheck<ListInput, any> = {
  argumentDomains(objective) {
    return { ...domains(objective), limit: { kind: "forbidden", reason: "the daemon returns up to 50 windows" } };
  },
  relevant: (o) => WINDOW_NOUN.test(o) || requestedProcess(o) !== null,
  clarify: actuationRefusal,
  facets(objective) {
    if (!isListRequest(objective)) return [];
    const p = requestedProcess(objective);
    const t = requestedTitle(objective);
    return [{ id: `desktop:list:${p ?? "*"}:${t ?? "*"}`, tool: "desktop.list_windows", description: `list the open windows${p ? ` of ${p}` : ""}${t ? ` titled like "${t}"` : ""}`, data: { process: p, title: t } } satisfies RequestFacet];
  },
  ground(input, objective) {
    if (!isListRequest(objective)) return ungrounded("the request does not ask which windows are open");
    return selectorMatches(input, objective);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    const d = facet.data as { process: string | null; title: string | null };
    return outcome.ok && !!o && o.complete === true && Array.isArray(o.windows) &&
      (input.process ?? null) === d.process && (input.titleContains ?? null) === d.title;
  },
  vocabulary: (objective) => [...VOCAB, ...appWords(objective)],
};

export function createListWindowsTool(bridge: DesktopBridge): ToolSpec<ListInput, any> {
  return {
    name: "desktop.list_windows",
    description: "List the application windows open on this computer (read-only). Optional: process (an application the user named) and titleContains (text the user quoted).",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", minLength: 1, maxLength: 64, description: "Only windows of this application, e.g. notepad.exe" },
        titleContains: { type: "string", minLength: 1, maxLength: 100, description: "Only windows whose title contains this text" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    permissions: ["read:desktop"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 8000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "desktop.list_windows", { ...input }, ctx, 7000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? reply.status, evidence: "" };
      const r = reply.result;
      const windows: any[] = Array.isArray(r?.windows) ? r.windows : [];
      const lines = windows.map((w) => `• ${w.process}: "${w.title}" (${fmtDisplay(w.display)}${w.minimized ? ", minimized" : ""}${w.foreground ? ", in front" : ""})`);
      const extra: string[] = [];
      if (r?.truncated) extra.push(`showing ${r.returned} of ${r.total}`);
      if (r?.disappeared) extra.push(`${r.disappeared} closed while being read`);
      if (r?.excludedIncompleteIdentity) extra.push(`${r.excludedIncompleteIdentity} skipped (identity could not be established)`);
      const head = windows.length === 0
        ? `No open windows${r?.filter?.process ? ` of ${r.filter.process}` : ""}${r?.filter?.titleContains ? ` titled like "${r.filter.titleContains}"` : ""}.`
        : `Open windows (${windows.length}${extra.length ? `; ${extra.join("; ")}` : ""}):`;
      // An incomplete list is said to be incomplete, never presented as the whole desktop ("satisfies" also refuses it).
      const caveat = r?.complete === true ? [] : [`This list may be incomplete: ${r?.incompleteReason ?? "not every window could be accounted for"}.`];
      return { ok: true, output: r, evidence: [head, ...lines, ...caveat].join("\n") };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o || !Array.isArray(o.windows)) return { ok: false, reason: "no window list" };
      if (Date.parse(o.completedAtUtc) > Date.parse(o.expiresAtUtc)) return { ok: false, reason: "the observation was stale" };
      for (const w of o.windows) {
        const id = w?.identity;
        if (!id || !id.hwnd || !id.pid || !id.imagePath || !id.windowClass || !id.processCreationTimeUtc) return { ok: false, reason: "a window without a complete identity" };
      }
      return { ok: true };
    },
    requestCheck: listWindowsCheck,
  };
}

// ── desktop.inspect_window ─────────────────────────────────────────────────

interface InspectInput { process?: string; titleContains?: string }

export const inspectWindowCheck: ToolRequestCheck<InspectInput, any> = {
  argumentDomains: domains,
  relevant: (o) => WINDOW_NOUN.test(o) || requestedProcess(o) !== null,
  clarify: (o) => actuationRefusal(o) ?? inspectClarification(o),
  facets(objective) {
    if (!isInspectRequest(objective)) return [];
    const p = requestedProcess(objective);
    const t = requestedTitle(objective);
    if (!p && !t) return [];
    return [{ id: `desktop:inspect:${p ?? "*"}:${t ?? "*"}`, tool: "desktop.inspect_window", description: `inspect the window ${t ? `"${t}"` : ""}${p ? ` of ${p}` : ""}`.trim(), data: { process: p, title: t } } satisfies RequestFacet];
  },
  ground(input, objective) {
    if (!isInspectRequest(objective)) return ungrounded("the request does not ask to inspect a window");
    if (!requestedProcess(objective) && !requestedTitle(objective)) return ungrounded("the request does not name a window");
    return selectorMatches(input, objective);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    const d = facet.data as { process: string | null; title: string | null };
    return outcome.ok && !!o && o.identityRevalidated === true && (o.uia?.status === "ok" || o.uia?.status === "partial") &&
      (input.process ?? null) === d.process && (input.titleContains ?? null) === d.title;
  },
  vocabulary: (objective) => [...VOCAB, ...appWords(objective)],
};

export function createInspectWindowTool(bridge: DesktopBridge): ToolSpec<InspectInput, any> {
  return {
    name: "desktop.inspect_window",
    description: "Read the UI elements of one window the user named (read-only): give process (an application the user named) and/or titleContains (text the user quoted).",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", minLength: 1, maxLength: 64 },
        titleContains: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    permissions: ["read:desktop"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 8000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "desktop.inspect_window", { ...input }, ctx, 7000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? reply.status, evidence: "" };
      const r = reply.result;
      const w = r?.window ?? {};
      const uia = r?.uia ?? {};
      const els: any[] = Array.isArray(uia.elements) ? uia.elements : [];
      const shown = els.filter((e) => e.depth > 0).slice(0, 40).map((e) => {
        const label = e.name ? ` "${e.name}"` : e.automationId ? ` #${e.automationId}` : "";
        const flags = [e.isPassword ? "password field: value not read" : "", e.enabled === false ? "disabled" : "", e.patterns?.length ? e.patterns.join("/") : ""].filter(Boolean).join(", ");
        return `${"  ".repeat(Math.max(0, e.depth - 1))}• ${e.controlType}${label}${flags ? ` (${flags})` : ""}`;
      });
      const status = uia.status === "ok" ? `${els.length} elements` : `UI Automation ${uia.status}${uia.detail ? `: ${uia.detail}` : ""}; ${els.length} elements`;
      const head = `Window "${w.title}" (${w.process}, PID ${w.identity?.pid}, ${fmtDisplay(w.display)}): ${status}${uia.truncated ? " (truncated)" : ""}.`;
      return { ok: true, output: r, evidence: [head, ...shown, ...(els.length - 1 > shown.length ? [`… ${els.length - 1 - shown.length} more`] : [])].join("\n") };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o || o.identityRevalidated !== true) return { ok: false, reason: "the window's identity was not revalidated" };
      if (Date.parse(o.completedAtUtc) > Date.parse(o.expiresAtUtc)) return { ok: false, reason: "the observation was stale" };
      return { ok: true };
    },
    // The up-front refusal knows which input tools the daemon offered (P1/P2 off: input requests are refused as before).
    requestCheck: { ...inspectWindowCheck, clarify: (o) => actuationRefusal(o, (t) => offered(bridge, t)) ?? inspectClarification(o) },
  };
}

// ── desktop.focus_window / desktop.set_window_state (Phase 7B.2: approval only) ──

interface ActionInput { process?: string; titleContains?: string; state?: "minimize" | "maximize" | "restore" }

const ACTION_LABEL: Record<string, string> = { minimize: "minimizing", maximize: "maximizing", restore: "restoring" };

function windowActionCheck(tool: WindowActionRequest["tool"]): ToolRequestCheck<ActionInput, any> {
  const mine = (o: string) => requestedWindowActions(o).some((a) => a.tool === tool) && !actuationRefusal(o);
  /** The states this tool may be asked for, in the order requested. */
  const statesOf = (o: string) => [...new Set(requestedWindowActions(o).filter((a) => a.tool === tool && a.state).map((a) => a.state!))];
  return {
    argumentDomains(objective) {
      const d = domains(objective);
      if (tool === "desktop.set_window_state") {
        const states = statesOf(objective);
        d.state = states.length > 0 ? { kind: "enum", values: states, optional: false } : { kind: "forbidden", reason: "the request asks for no window state" };
      }
      return d;
    },
    relevant: (o) => mine(o),
    clarify: (o) => (requestedWindowActions(o).some((a) => a.tool === tool) ? windowActionClarification(o) : null),
    facets(objective) {
      if (!mine(objective)) return [];
      const p = requestedProcess(objective);
      const t = requestedTitle(objective);
      if (!p && !t) return [];
      const ops = requestedWindowActions(objective);
      // Several operations on several windows are answered with a question before planning; nothing to verify here.
      if (ops.length > 1 && namesSeveralWindows(objective)) return [];
      const out: RequestFacet[] = [];
      ops.forEach((a, i) => {
        if (a.tool !== tool) return;
        const what = a.state ?? "focus";
        out.push(ops.length === 1
          ? { id: `desktop:action:${what}:${p ?? "*"}:${t ?? "*"}`, tool, description: `ask approval to ${what} the window`, data: { state: a.state } }
          : { id: `desktop:action:${i + 1}of${ops.length}:${what}:${p ?? "*"}:${t ?? "*"}`, tool, description: `operation ${i + 1} of ${ops.length}: ${what} the window`,
              data: { state: a.state }, sequence: { key: "window-operations", index: i, of: ops.length } });
      });
      return out;
    },
    ground(input, objective) {
      if (!mine(objective)) return ungrounded("the request does not ask for this window operation");
      const states = statesOf(objective);
      if (tool === "desktop.set_window_state" && !(input.state && states.includes(input.state))) return contradicted(`the request asks to ${states.join(", then ") || "do something else"}`);
      return selectorMatches(input, objective);
    },
    // Phase 7B.3: satisfied only when the daemon performed the operation AND an independent observation confirmed it,
    // for the state the request asked for. An approval alone (execution off), or an unverified execution, never is.
    // For several operations each facet needs its own executed step, in order (grounding.ts).
    satisfies(facet, input, outcome) {
      const o = outcome.output;
      const want = (facet.data as { state: string | null }).state;
      return outcome.ok && !!o && o.executed === true && o.verified === true && (o.state ?? null) === want && (input.state ?? null) === want;
    },
    vocabulary: (objective) => [...VOCAB, "focus", "bring", "front", "switch", "to", "activate", "minimize", "minimise", "maximize", "maximise", "restore", ...appWords(objective)],
  };
}

function createWindowActionTool(bridge: DesktopBridge, tool: WindowActionRequest["tool"]): ToolSpec<ActionInput, any> {
  const askedIn = new Set<string>();
  const stateTool = tool === "desktop.set_window_state";
  return {
    name: tool,
    description: stateTool
      ? "Ask the user (in the HUD) to approve minimizing, maximizing or restoring one window they named. Give process and/or titleContains from the request, and state."
      : "Ask the user (in the HUD) to approve bringing one window they named to the front. Give process and/or titleContains from the request.",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", minLength: 1, maxLength: 64 },
        titleContains: { type: "string", minLength: 1, maxLength: 100 },
        ...(stateTool ? { state: { type: "string", enum: ["minimize", "maximize", "restore"] } } : {}),
      },
      ...(stateTool ? { required: ["state"] } : {}),
    },
    // Only to REQUEST an action. The daemon owns the target, the approval and the decision; this runtime's own approval
    // gate is not involved (it could not show the user anything) and nothing here can perform the action.
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 40_000,
    async execute(input, ctx) {
      // One approval prompt per task: a re-plan never asks the user again.
      if (askedIn.has(ctx.taskId)) return { ok: false, error: "Already asked for approval once in this task; not asking again.", evidence: "" };
      askedIn.add(ctx.taskId);
      const { reply, error } = await callDaemon(bridge, tool, { ...input }, ctx, 36_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status === "cancelled") return { ok: false, error: "The request was cancelled. Nothing was done.", evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "The request was not approved. Nothing was done.", evidence: "" };
      const r = reply.result ?? {};
      const what = stateTool ? `${ACTION_LABEL[String(input.state)] ?? "changing"} "${r?.target?.title}"` : `bringing "${r?.target?.title}" to the front`;
      // Phase 7B.3: done only when the daemon performed it AND observed the result independently.
      if (r.executed === true && r.verified === true) {
        const done = stateTool ? `${String(input.state) === "minimize" ? "Minimized" : String(input.state) === "maximize" ? "Maximized" : "Restored"} "${r?.target?.title}"` : `Brought "${r?.target?.title}" to the front`;
        return { ok: true, output: r, evidence: `${done} (${r.target?.process}). Verified by a fresh observation of the same window: ${r.observed}.` };
      }
      // Approved and validated by the daemon, but NOT performed (execution switched off): reported as not done.
      return {
        ok: false,
        output: r,
        error: `You approved ${what}, and D-ASK validated your approval, but did not perform it: acting on windows is not available in this version. Nothing on screen changed.`,
        evidence: "",
      };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o || o.executed !== true || o.verified !== true) return { ok: false, reason: "the operation was not performed and verified" };
      return { ok: true };
    },
    requestCheck: windowActionCheck(tool),
  };
}

// ── P1 / P2: element-bound input requests (approval-gated; the daemon resolves, approves, performs and verifies) ──
//
// Conservative grammar; a request is one input step, or an ordered sequence of up to MAX_INPUT_STEPS of them:
//   Click the <target> button|checkbox|link|tab|menu item|radio button   … of the window titled "…" / in <App>
//   Type "<text>" into|in the <target> field|box|text box …               (the text must be quoted exactly)
//   Press <Enter|Tab|Ctrl+A|…> in|into|on the <target> field|box|button …
// The window is named as before (quoted title after "window titled", or an application). The control is named in the
// request and must match the element the plan uses. Anything else (drag, scroll, right/double click, close, launch, …)
// is still refused by actuationRefusal.

export type InputTool = "desktop.click_element" | "desktop.type_text" | "desktop.press_keys"
  | "desktop.right_click_element" | "desktop.double_click_element" | "desktop.scroll" | "desktop.drag_element" | "desktop.select_text";
export const INPUT_TOOLS: readonly InputTool[] = ["desktop.click_element", "desktop.type_text", "desktop.press_keys",
  "desktop.right_click_element", "desktop.double_click_element", "desktop.scroll", "desktop.drag_element", "desktop.select_text"];
export interface InputActionRequest {
  tool: InputTool;
  /** type_text: the text to type; select_text: the exact text to select (null: all of it). */
  text: string | null;
  keys: string | null;
  target: string;
  /** The UI Automation control type the request's noun names ("button" -> Button, "field" -> Edit, ...). */
  controlType: string;
  /** drag_element: the control to drop on. */
  to?: { target: string; controlType: string } | null;
  /** scroll: direction and wheel notches. */
  direction?: "up" | "down" | "left" | "right" | null;
  amount?: number | null;
}

const CONTROL_NOUN = "(button|checkbox|check box|link|tab|menu item|radio button|list item|tree item|item|list|document|pane|field|text box|textbox|edit box|box|input)";
const POLITE = "^\\s*(?:please\\s+|can you\\s+|could you\\s+)?";
const CLICK_REQ = new RegExp(`${POLITE}click\\s+(?:on\\s+)?(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const TYPE_REQ = new RegExp(`${POLITE}(?:type|enter|write)\\s+["“'‘]([^"”'’]{1,200})["”'’]\\s+(?:into|in)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const KEY_TOKEN = "((?:(?:ctrl|control|shift)\\s*\\+\\s*)*(?:enter|tab|escape|esc|backspace|delete|insert|space|up|down|left|right|home|end|page ?up|page ?down|f10|f2|f3|f5|f6|[abcfilnpstuvxyz]))";
const PRESS_REQ = new RegExp(`${POLITE}press\\s+${KEY_TOKEN}\\s+(?:in|into|on)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
// Complete desktop input (2026-11-14).
const RIGHT_CLICK_REQ = new RegExp(`${POLITE}right[- ]?click\\s+(?:on\\s+)?(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const DOUBLE_CLICK_REQ = new RegExp(`${POLITE}double[- ]?click\\s+(?:on\\s+)?(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const NUMBER_WORDS: Record<string, number> = { once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const SCROLL_REQ = new RegExp(`${POLITE}scroll\\s+(up|down|left|right)(?:\\s+(?:by\\s+)?(\\d{1,2}|once|twice|one|two|three|four|five|six|seven|eight|nine|ten)(?:\\s+(?:times|notches|steps|clicks))?)?\\s+(?:in|on|over|inside)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const DRAG_REQ = new RegExp(`${POLITE}(?:drag(?:\\s+and\\s+drop)?|move)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\s+(?:to|onto|into|over\\s+to)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const SELECT_ALL_REQ = new RegExp(`${POLITE}select\\s+(?:all(?:\\s+(?:of\\s+)?the)?(?:\\s+text)?|everything|the\\s+whole\\s+text)\\s+(?:in|of)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const SELECT_TEXT_REQ = new RegExp(`${POLITE}(?:select|highlight)\\s+(?:the\\s+(?:text|word|words)\\s+)?["“'‘]([^"”'’]{1,200})["”'’]\\s+(?:in|of)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const NOUN_TYPE: Record<string, string> = {
  button: "Button", checkbox: "CheckBox", "check box": "CheckBox", link: "Hyperlink", tab: "TabItem", "menu item": "MenuItem",
  "radio button": "RadioButton", field: "Edit", "text box": "Edit", textbox: "Edit", "edit box": "Edit", box: "Edit", input: "Edit",
  "list item": "ListItem", item: "ListItem", "tree item": "TreeItem", list: "List", document: "Document", pane: "Pane",
};
const typeOf = (noun: string) => NOUN_TYPE[noun.toLowerCase().replace(/\s+/g, " ")] ?? "Edit";
const INPUT_FORBIDDEN = /\b(close|launch|kill|terminate|quit|shut ?down|uninstall|format)\b/i;
const QUOTED_ANY = /["“'‘][^"”'’]{1,200}["”'’]/g;
const SECOND_ACTION = /\b(?:and|then)\b\s+(?:then\s+)?(?:click|type|enter|write|press|right[- ]?click|double[- ]?click|scroll|drag|select|minimi[sz]e|maximi[sz]e|restore|focus|bring|open|run|launch|close)\b/i;

/** Mirrors the daemon's allow-list (KeyChords.Allowed); the daemon re-validates every chord. */
const ALLOWED_CHORDS = new Set([
  "Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space", "Up", "Down", "Left", "Right", "Home", "End",
  "PageUp", "PageDown", "F2", "Ctrl+A", "Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Ctrl+Home", "Ctrl+End",
  "Shift+Home", "Shift+End", "Shift+Left", "Shift+Right",
  // 2026-11-14 (mirrors KeyChords.Allowed): selection, word navigation and common shortcuts. Never Alt+F4, Alt+Tab, Win, Ctrl+W, Ctrl+Q.
  "Shift+Up", "Shift+Down", "Shift+PageUp", "Shift+PageDown", "Ctrl+Left", "Ctrl+Right", "Ctrl+Up", "Ctrl+Down",
  "Ctrl+Shift+Left", "Ctrl+Shift+Right", "Ctrl+Shift+Home", "Ctrl+Shift+End", "Ctrl+Backspace", "Ctrl+Delete",
  "Ctrl+B", "Ctrl+I", "Ctrl+U", "Ctrl+F", "Ctrl+N", "Ctrl+S", "Ctrl+T", "Ctrl+L", "Ctrl+P", "Ctrl+Shift+Z", "Ctrl+Shift+T",
  "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+PageUp", "Ctrl+PageDown", "Ctrl+Insert", "Shift+Insert", "Shift+Delete",
  "F3", "Shift+F3", "F5", "F6", "F10", "Shift+F10",
]);
const KEY_NAMES: Record<string, string> = {
  enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: "Space",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", f2: "F2",
  f3: "F3", f5: "F5", f6: "F6", f10: "F10", insert: "Insert",
};

/** "ctrl + a" -> "Ctrl+A"; null if it is not an allowed chord. */
export function canonicalChord(raw: string): string | null {
  const parts = raw.split("+").map((p) => p.trim().toLowerCase().replace(/\s+/g, ""));
  let ctrl = false, shift = false, key: string | null = null;
  for (const p of parts) {
    if (p === "ctrl" || p === "control") { if (ctrl) return null; ctrl = true; }
    else if (p === "shift") { if (shift) return null; shift = true; }
    else if (key === null) key = KEY_NAMES[p] ?? (/^[abcfilnpstuvxyz]$/.test(p) ? p.toUpperCase() : null);
    else return null;
    if (key === null && p !== "ctrl" && p !== "control" && p !== "shift") return null;
  }
  if (!key) return null;
  const c = (ctrl ? "Ctrl+" : "") + (shift ? "Shift+" : "") + key;
  return ALLOWED_CHORDS.has(c) ? c : null;
}

/** The daemon's per-task input budget (AgentHostDesktopCalls.MaxInputRequestsPerTask): each step is approved separately. */
export const MAX_INPUT_STEPS = 6;

// ── "Open Notepad [and type …]": one application session (desktop.launch_app, then desktop.type_text) ──

/** What the daemon exposes for Notepad on Windows 11 (observed): a focused Document control named "Text editor" that takes the Value pattern. */
const APP_EDITOR = { controlType: "Document", name: "Text editor" } as const;
/**
 * The applications D-ASK can open: EXACTLY the daemon's fixed list (KnownApps in AppLaunchRequestService.cs), with the window process the
 * daemon confirms. Only Notepad can also be typed into (its editor control was observed end to end); the others are open-only.
 */
export const LAUNCHABLE = {
  notepad: { name: "Notepad", process: "notepad.exe", words: "notepad", typing: true },
  calculator: { name: "Calculator", process: "ApplicationFrameHost.exe", words: "calculator|calc", typing: false },
  charmap: { name: "Character Map", process: "charmap.exe", words: String.raw`character\s+map|charmap`, typing: false },
} as const;
export type AppKey = keyof typeof LAUNCHABLE;
export interface AppSession { app: AppKey; process: string; text: string | null }
const OPEN_APPS = (Object.keys(LAUNCHABLE) as AppKey[]).map((k) => [k, new RegExp(
  String.raw`^\s*(?:please\s+|can you\s+|could you\s+)?(?:open|launch|start|run)\s+(?:up\s+)?(?:the\s+|a\s+)?(?:${LAUNCHABLE[k].words})(?:\s+(?:app|application|window))?\b([\s\S]*)$`, "i")] as const);
const THEN_TYPE = /^\s*(?:[,;]\s*)?(?:and\s+)?(?:then\s+)?(?:type|write|enter)\s+([\s\S]+)$/i;
const IN_IT = /\s+(?:in|into)\s+(?:it|notepad|the\s+(?:editor|window|document|text\s+area))\s*$/i;
/** Another action after the text: the text would run on into it, so the whole request is refused rather than guessed. */
const TEXT_RUNS_ON = /\b(?:then|afterwards|after that)\b|\band\s+(?:save|close|print|send|delete|open|press|click|type|write|enter|launch|minimi[sz]e|maximi[sz]e)\b/i;

/**
 * The request as an application session, or null. Quoted text is used exactly; unquoted text is everything after "type" up to
 * the end of the sentence, and the request is refused (null) when that text could be running on into another instruction.
 * The text is shown in full on the approval card before anything is typed.
 */
export function appSession(o: string): AppSession | null {
  let m: RegExpExecArray | null = null; let key: AppKey | null = null;
  for (const [k, re] of OPEN_APPS) { m = re.exec(o); if (m) { key = k; break; } }
  if (!m || !key) return null;
  const rest = m[1]!.trim();
  if (rest === "" || /^[.!?]+$/.test(rest)) return { app: key, process: LAUNCHABLE[key].process, text: null };
  if (!LAUNCHABLE[key].typing) return null;   // "open Calculator and type …": no typing target is defined for it
  const t = THEN_TYPE.exec(rest);
  if (!t) return null;
  const body = t[1]!.trim();
  let text: string | null = null;
  const q = /^["“'‘]([\s\S]{1,200}?)["”'’](?:\s+(?:in|into)\s+(?:it|notepad|the\s+(?:editor|window|document|text\s+area)))?\s*[.!?]?\s*$/.exec(body);
  if (q) text = q[1]!;
  else if (!/^["“'‘]/.test(body)) {
    const plain = body.replace(/[.!?]+\s*$/, "").replace(IN_IT, "").trim();
    if (plain.length >= 1 && plain.length <= 200 && !/["“”]/.test(plain) && !TEXT_RUNS_ON.test(plain)) text = plain;
  }
  if (text === null || text.length === 0 || [...text].some((c) => c.charCodeAt(0) < 32)) return null;
  return { app: "notepad", process: "notepad.exe", text };
}

const INPUT_VERB = "(?:click|type|enter|write|press|right[- ]?click|double[- ]?click|scroll|drag|select|highlight)";
/** Step separators, only where the next word starts another input step: ", then", " and then", " then", " and", ";". */
const STEP_SPLIT = new RegExp(`(?:\\s*,\\s*(?:and\\s+)?(?:then\\s+)?|\\s*;\\s*(?:then\\s+)?|\\s+(?:and\\s+)?then\\s+|\\s+and\\s+)(?=${INPUT_VERB}\\b)`, "gi");
/** A later step may leave out the control it shares with the step before it ("… then press Enter"). */
const SHORT_PRESS = new RegExp(`^\\s*press\\s+${KEY_TOKEN}(?:\\s+(?:again|there|too))?(\\s+(?:in|on|of)\\s+.{1,160}?)?\\s*[.!]?\\s*$`, "i");
const SHORT_TYPE = new RegExp(`^\\s*(?:type|enter|write)\\s+["“'‘]([^"”'’]{1,200})["”'’](?:\\s+(?:again|there|too))?(\\s+(?:in|on|of)\\s+.{1,160}?)?\\s*[.!]?\\s*$`, "i");
const WINDOW_CLAUSE = /\b(?:window|app|application)\s+(?:titled|called|named)\b/gi;
const CONTROL_NOUN_RE = new RegExp(`\\b${CONTROL_NOUN}\\b`, "i");
const mask = (s: string) => s.replace(QUOTED_ANY, (q) => "_".repeat(q.length));

/** A trailing "in the window titled '…'" / "in Notepad" on a short step: a window, never another control. */
function onlyNamesWindow(rest: string | undefined): boolean {
  if (!rest) return true;
  const m = mask(rest);
  if (CONTROL_NOUN_RE.test(m)) return false;
  return WINDOW_NOUN.test(m) || /\.exe\b/i.test(m) || APPS.some(([re]) => re.test(m));
}

const unquote = (s: string) => s.replace(/^["“'‘]|["”'’]$/g, "").trim();
function parseInputStep(seg: string, previous: InputActionRequest | null): InputActionRequest | null {
  let m = RIGHT_CLICK_REQ.exec(seg);
  if (m) return { tool: "desktop.right_click_element", text: null, keys: null, target: unquote(m[1]!), controlType: typeOf(m[2]!) };
  m = DOUBLE_CLICK_REQ.exec(seg);
  if (m) return { tool: "desktop.double_click_element", text: null, keys: null, target: unquote(m[1]!), controlType: typeOf(m[2]!) };
  m = SCROLL_REQ.exec(seg);
  if (m) {
    const n = m[2] ? (/^\d+$/.test(m[2]) ? Number(m[2]) : NUMBER_WORDS[m[2].toLowerCase()] ?? 3) : 3;
    if (n < 1 || n > 15) return null;
    return { tool: "desktop.scroll", text: null, keys: null, target: unquote(m[3]!), controlType: typeOf(m[4]!), direction: m[1]!.toLowerCase() as "up", amount: n };
  }
  m = DRAG_REQ.exec(seg);
  if (m) return { tool: "desktop.drag_element", text: null, keys: null, target: unquote(m[1]!), controlType: typeOf(m[2]!), to: { target: unquote(m[3]!), controlType: typeOf(m[4]!) } };
  m = SELECT_TEXT_REQ.exec(seg);
  if (m) return { tool: "desktop.select_text", text: m[1]!, keys: null, target: unquote(m[2]!), controlType: typeOf(m[3]!) };
  m = SELECT_ALL_REQ.exec(seg);
  if (m) return { tool: "desktop.select_text", text: null, keys: null, target: unquote(m[1]!), controlType: typeOf(m[2]!) };
  m = TYPE_REQ.exec(seg);
  if (m) return { tool: "desktop.type_text", text: m[1]!, keys: null, target: m[2]!.trim(), controlType: typeOf(m[3]!) };
  m = PRESS_REQ.exec(seg);
  if (m) { const keys = canonicalChord(m[1]!); return keys ? { tool: "desktop.press_keys", text: null, keys, target: m[2]!.trim(), controlType: typeOf(m[3]!) } : null; }
  m = CLICK_REQ.exec(seg);
  if (m) return { tool: "desktop.click_element", text: null, keys: null, target: m[1]!.replace(/^["“'‘]|["”'’]$/g, "").trim(), controlType: typeOf(m[2]!) };
  if (!previous) return null;
  m = SHORT_PRESS.exec(seg);
  if (m && onlyNamesWindow(m[2])) { const keys = canonicalChord(m[1]!); return keys ? { tool: "desktop.press_keys", text: null, keys, target: previous.target, controlType: previous.controlType } : null; }
  m = SHORT_TYPE.exec(seg);
  if (m && onlyNamesWindow(m[2]) && previous.controlType === "Edit") return { tool: "desktop.type_text", text: m[1]!, keys: null, target: previous.target, controlType: previous.controlType };
  return null;
}

/**
 * Every element-bound input step the request asks for, in the order asked, or [] when the request is not entirely a
 * sequence of supported input steps (fail closed: one unparseable, forbidden or non-input step refuses the whole request).
 *   Type "x" into the search field of the window titled "T", then press Enter
 *   Click the Clear button and then type "abc" into the notes field in the window titled "T"
 * At most MAX_INPUT_STEPS steps, one window. Each step is approved separately in the HUD and asked for only after the
 * previous one was performed AND verified (createInputTool), never out of order and never retried.
 */
export function requestedInputActions(o: string): InputActionRequest[] {
  // "Open Notepad and type X": the typing step is bound to Notepad's own editor (the window the launch opened).
  const session = appSession(o);
  if (session) return session.text === null ? [] : [{ tool: "desktop.type_text", text: session.text, keys: null, target: APP_EDITOR.name, controlType: APP_EDITOR.controlType }];
  if (INPUT_FORBIDDEN.test(o)) return [];
  if ((o.match(WINDOW_CLAUSE) ?? []).length > 1) return []; // one window per request
  const masked = mask(o);
  const segments: string[] = [];
  let from = 0;
  for (const x of masked.matchAll(STEP_SPLIT)) { segments.push(o.slice(from, x.index!)); from = x.index! + x[0].length; }
  segments.push(o.slice(from));
  if (segments.length > MAX_INPUT_STEPS) return [];
  const out: InputActionRequest[] = [];
  for (const seg of segments) {
    if (SECOND_ACTION.test(mask(seg))) return []; // a non-input action (minimize, open, close …) inside the request
    const step = parseInputStep(seg, out.at(-1) ?? null);
    if (!step) return [];
    out.push(step);
  }
  return out;
}

/** The FIRST element-bound input step the request asks for, or null. */
export function requestedInputAction(o: string): InputActionRequest | null {
  return requestedInputActions(o)[0] ?? null;
}

/**
 * Agent-facing arguments. The control is named by two strings that argument domains pin to exactly what the request says
 * (the model never picks a control, as it never picks a window). The daemon receives them as element {controlType, name};
 * it resolves exactly one control whose name OR automation id is exactly that identifier, and refuses anything ambiguous.
 */
interface InputArgs { process?: string; titleContains?: string; controlType?: string; control?: string; text?: string; keys?: string;
  toControlType?: string; toControl?: string; direction?: string; amount?: number }

const offered = (b: DesktopBridge, tool: string): boolean => (b.offers ? b.offers(tool) : true);
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))];

/** Whether the planned arguments are exactly this requested step (tool, control, and its text or keys). */
function isStep(tool: string, input: InputArgs, a: InputActionRequest): boolean {
  return a.tool === tool && input.controlType === a.controlType && input.control === a.target &&
    (input.text ?? null) === a.text && (input.keys ?? null) === a.keys &&
    (input.toControl ?? null) === (a.to?.target ?? null) && (input.toControlType ?? null) === (a.to?.controlType ?? null) &&
    (input.direction ?? null) === (a.direction ?? null) && (input.amount ?? null) === (a.amount ?? null);
}

const verbOf = (a: InputActionRequest) => {
  switch (a.tool) {
    case "desktop.click_element": return "click";
    case "desktop.type_text": return "type into";
    case "desktop.right_click_element": return "right-click";
    case "desktop.double_click_element": return "double-click";
    case "desktop.scroll": return `scroll ${a.direction} ${a.amount}x in`;
    case "desktop.drag_element": return `drag onto the ${a.to?.target} control`;
    case "desktop.select_text": return a.text === null ? "select all text in" : "select text in";
    default: return `press ${a.keys} in`;
  }
};

function inputCheck(tool: InputActionRequest["tool"], bridge: DesktopBridge): ToolRequestCheck<InputArgs, any> {
  /** The request's steps, only if the daemon offers every input tool they need (otherwise the request is refused). */
  const stepsOf = (o: string) => { const s = requestedInputActions(o); return s.every((a) => offered(bridge, a.tool)) ? s : []; };
  const mine = (o: string) => stepsOf(o).some((a) => a.tool === tool);
  return {
    argumentDomains(objective) {
      const own = stepsOf(objective).filter((a) => a.tool === tool);
      const d = domains(objective);
      const none: ArgumentDomain = { kind: "forbidden", reason: "the request names no control for this input" };
      d.controlType = own.length ? { kind: "enum", values: uniq(own.map((a) => a.controlType)), optional: false } : none;
      d.control = own.length ? { kind: "enum", values: uniq(own.map((a) => a.target)), optional: false } : none;
      if (tool === "desktop.type_text") d.text = own.length ? { kind: "enum", values: uniq(own.map((a) => a.text)), optional: false } : { kind: "forbidden", reason: "the request quotes no text to type" };
      if (tool === "desktop.select_text") d.text = own.some((a) => a.text !== null) ? { kind: "enum", values: uniq(own.map((a) => a.text)), optional: own.some((a) => a.text === null) } : { kind: "forbidden", reason: "the request selects all text" };
      if (tool === "desktop.drag_element") {
        d.toControl = own.length ? { kind: "enum", values: uniq(own.map((a) => a.to?.target ?? null)), optional: false } : none;
        d.toControlType = own.length ? { kind: "enum", values: uniq(own.map((a) => a.to?.controlType ?? null)), optional: false } : none;
      }
      if (tool === "desktop.scroll") {
        d.direction = own.length ? { kind: "enum", values: uniq(own.map((a) => a.direction ?? null)), optional: false } : none;
        // amount is a number (enum domains hold text): it is pinned by ground()/isStep, which compares it exactly.
      }
      if (tool === "desktop.press_keys") d.keys = own.length ? { kind: "enum", values: uniq(own.map((a) => a.keys)), optional: false } : { kind: "forbidden", reason: "the request names no allowed key" };
      return d;
    },
    relevant: (o) => mine(o),
    // "Open Notepad and type X": the typing step belongs to this tool together with the launch (see createLaunchAppTool.claims).
    claims: (o) => tool === "desktop.type_text" && appSession(o)?.text != null && mine(o) && offered(bridge, "desktop.launch_app"),
    clarify: (o) => (mine(o) && !requestedProcess(o) && !requestedTitle(o)
      ? "Which window do you mean? Quote its title (\"… in the window titled '…'\") or name the application. I won't pick a window for you."
      : null),
    facets(objective) {
      if (!mine(objective)) return [];
      const p = requestedProcess(objective);
      const t = requestedTitle(objective);
      if (!p && !t) return [];
      const steps = stepsOf(objective);
      // In an application session the launch is step 0 of the same ordered sequence: the typing counts only AFTER the launch.
      const lead = appSession(objective) ? 1 : 0;
      const total = steps.length + lead;
      const out: RequestFacet[] = [];
      steps.forEach((a, i) => {
        if (a.tool !== tool) return;
        const data = { target: a.target, controlType: a.controlType, text: a.text, keys: a.keys, to: a.to ?? null, direction: a.direction ?? null, amount: a.amount ?? null };
        out.push(total === 1
          ? { id: `desktop:input:${tool}:${p ?? "*"}:${t ?? "*"}`, tool, description: `${verbOf(a)} the ${a.target} control`, data }
          : { id: `desktop:input:${i + lead + 1}of${total}:${tool}:${p ?? "*"}:${t ?? "*"}`, tool, description: `input ${i + lead + 1} of ${total}: ${verbOf(a)} the ${a.target} control`,
              data, sequence: { key: "input-steps", index: i + lead, of: total } });
      });
      return out;
    },
    ground(input, objective) {
      if (!mine(objective)) return ungrounded("the request does not ask for this input");
      const sel = selectorMatches(input, objective);
      if (sel.status !== "grounded") return sel;
      const own = stepsOf(objective).filter((a) => a.tool === tool);
      if (own.some((a) => isStep(tool, input, a))) return grounded("window, control and input are taken from the request");
      const a = own[0]!;
      if (!own.some((x) => input.control === x.target && input.controlType === x.controlType)) return contradicted(`the request names the ${a.controlType} "${a.target}"`);
      if (tool === "desktop.type_text") return contradicted("the text must be exactly the quoted text for that control");
      if (tool === "desktop.press_keys") return contradicted(`the request asks for ${uniq(own.map((x) => x.keys)).join(" / ")}`);
      return contradicted("this input is not one the request asks for");
    },
    // Satisfied only when the daemon performed THIS step's input AND an independent observation confirmed its effect.
    satisfies(facet, input, outcome) {
      const o = outcome.output;
      const d = facet.data as InputActionRequest;
      return outcome.ok && !!o && o.executed === true && o.verified === true &&
        isStep(tool, input, { ...d, tool });
    },
    identicalStepsAllowed: (input, objective) => stepsOf(objective).filter((a) => isStep(tool, input as InputArgs, a)).length,
    stepFor(facet, objective) {
      if (facet.tool !== tool || !facet.sequence || !mine(objective)) return null;
      const a = stepsOf(objective)[facet.sequence.index - (appSession(objective) ? 1 : 0)];
      const p = requestedProcess(objective);
      const t = requestedTitle(objective);
      if (!a || a.tool !== tool || (!p && !t)) return null;
      const input: InputArgs = { ...(p ? { process: p } : {}), ...(t ? { titleContains: t } : {}), controlType: a.controlType, control: a.target,
        ...(a.text != null ? { text: a.text } : {}), ...(a.keys != null ? { keys: a.keys } : {}),
        ...(a.to ? { toControl: a.to.target, toControlType: a.to.controlType } : {}),
        ...(a.direction ? { direction: a.direction, amount: a.amount ?? 3 } : {}) };
      return this.ground(input, objective).status === "grounded" ? (input as Record<string, unknown>) : null;
    },
    vocabulary: (objective) => {
      const steps = requestedInputActions(objective);
      return [...VOCAB, "click", "on", "type", "enter", "write", "press", "into", "in", "field", "box", "textbox", "text", "edit", "input",
        "button", "checkbox", "check", "link", "tab", "menu", "item", "radio", "ctrl", "control", "shift", "esc", "escape", "backspace", "delete",
        "space", "up", "down", "left", "right", "home", "end", "page", "pageup", "pagedown", "then", "and", "again", "there", "too",
        "double", "double-click", "right-click", "doubleclick", "rightclick", "scroll", "by", "times", "notches", "steps", "clicks", "drag", "drop", "move",
        "onto", "to", "over", "select", "highlight", "all", "everything", "whole", "of", "word", "words", "list", "item", "tree", "document", "pane", "inside",
        "once", "twice", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        ...steps.flatMap((a) => [...contentWords(a.target), ...contentWords(a.text ?? ""), ...contentWords(a.keys?.replace(/\+/g, " ") ?? ""), ...contentWords(a.to?.target ?? "")]),
        ...appWords(objective)];
    },
  };
}

const INPUT_LABEL: Record<InputActionRequest["tool"], string> = {
  "desktop.click_element": "Clicked", "desktop.type_text": "Typed the text into", "desktop.press_keys": "Pressed the keys in",
  "desktop.right_click_element": "Right-clicked", "desktop.double_click_element": "Double-clicked", "desktop.scroll": "Scrolled",
  "desktop.drag_element": "Dragged", "desktop.select_text": "Selected text in",
};
const INPUT_DESCRIPTION: Record<InputActionRequest["tool"], string> = {
  "desktop.click_element": "Ask the user (in the HUD) to approve ONE left click on one control of a window they named. Give process and/or titleContains from the request, and element {controlType, automationId or name} exactly as desktop.inspect_window lists it. Never coordinates.",
  "desktop.type_text": "Ask the user (in the HUD) to approve typing the exact quoted text into one text field of a window they named. Give the window selector, element {controlType, automationId or name} from desktop.inspect_window, and text.",
  "desktop.press_keys": "Ask the user (in the HUD) to approve pressing ONE allowed key chord (e.g. Enter, Tab, Ctrl+A, Ctrl+S) in one control of a window they named. Give the window selector, element from desktop.inspect_window, and keys.",
  "desktop.right_click_element": "Ask the user (in the HUD) to approve ONE right click (context menu) on one control of a window they named.",
  "desktop.double_click_element": "Ask the user (in the HUD) to approve ONE double click on one control of a window they named.",
  "desktop.scroll": "Ask the user (in the HUD) to approve scrolling up/down/left/right by a number of wheel notches over one control of a window they named.",
  "desktop.drag_element": "Ask the user (in the HUD) to approve dragging one control and dropping it on another control of the same window.",
  "desktop.select_text": "Ask the user (in the HUD) to approve selecting text (all of it, or an exact quoted part) in one text control, through UI Automation (no keys).",
};

/**
 * Per-task input progress, shared by the three input tools. A request's steps are asked for strictly in order: the next
 * step may reach the daemon only after every earlier one was performed AND verified. A step that the daemon did not
 * perform and verify (denied, stopped, interrupted, unverified, failed) ends the sequence for the task: nothing later is
 * asked for, nothing is retried. Out-of-order or repeated steps never reach the daemon. Without the request (a direct
 * invocation), at most one input approval per task, as before.
 */
interface InputProgress { next: number; halted: boolean; asked: number }
const inputProgress = new Map<string, InputProgress>();

function createInputTool(bridge: DesktopBridge, tool: InputActionRequest["tool"]): ToolSpec<InputArgs, any> {
  return {
    name: tool,
    description: INPUT_DESCRIPTION[tool],
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", minLength: 1, maxLength: 64 },
        titleContains: { type: "string", minLength: 1, maxLength: 100 },
        controlType: { type: "string", minLength: 1, maxLength: 40 },
        control: { type: "string", minLength: 1, maxLength: 200 },
        ...(tool === "desktop.type_text" ? { text: { type: "string", minLength: 1, maxLength: 200 } } : {}),
        ...(tool === "desktop.press_keys" ? { keys: { type: "string", minLength: 1, maxLength: 32 } } : {}),
        ...(tool === "desktop.select_text" ? { text: { type: "string", minLength: 1, maxLength: 200 } } : {}),
        ...(tool === "desktop.drag_element" ? { toControlType: { type: "string", minLength: 1, maxLength: 40 }, toControl: { type: "string", minLength: 1, maxLength: 200 } } : {}),
        ...(tool === "desktop.scroll" ? { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 15 } } : {}),
      },
      required: ["controlType", "control", ...(tool === "desktop.type_text" ? ["text"] : tool === "desktop.press_keys" ? ["keys"]
        : tool === "desktop.drag_element" ? ["toControlType", "toControl"] : tool === "desktop.scroll" ? ["direction"] : [])],
    },
    // Only to REQUEST input. The daemon owns the target, the approval, the per-event gates and the verification.
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 60_000,
    async execute(input, ctx) {
      // An application session starts by opening the application: nothing is typed into a window this task did not open and confirm.
      if (ctx.objective !== undefined && appSession(ctx.objective) && !launchedTasks.has(ctx.taskId))
        return { ok: false, error: "This request begins by opening Notepad; nothing is typed until it has been opened and confirmed in this task. Nothing was sent.", evidence: "" };
      const prog = inputProgress.get(ctx.taskId) ?? { next: 0, halted: false, asked: 0 };
      inputProgress.set(ctx.taskId, prog);
      const steps = ctx.objective !== undefined ? requestedInputActions(ctx.objective) : [];
      let pre = "";
      if (steps.length === 0) {
        if (prog.asked > 0) return { ok: false, error: "Already asked for an input approval in this task; not asking again.", evidence: "" };
      } else {
        if (prog.halted) return { ok: false, error: "An earlier input step in this task was not performed and verified; no further input is asked for.", evidence: "" };
        if (prog.next >= steps.length) return { ok: false, error: "Already asked for every input step this request contains; not asking again.", evidence: "" };
        const want = steps[prog.next]!;
        if (!isStep(tool, input, want)) {
          const repeated = steps.slice(0, prog.next).some((a) => isStep(tool, input, a));
          return { ok: false, error: repeated
            ? `That input was already performed and verified in this task; not repeated. Next is input ${prog.next + 1} of ${steps.length}: ${verbOf(want)} the ${want.target} control.`
            : `Out of order: the next input is ${prog.next + 1} of ${steps.length}: ${verbOf(want)} the ${want.target} control. Nothing was sent.`, evidence: "" };
        }
        if (steps.length > 1) pre = `Input ${prog.next + 1} of ${steps.length}: `;
      }
      prog.asked += 1;
      // The daemon's contract: the window selector, ONE element (a single exact identifier: name or automation id), the text or keys.
      const args: Record<string, unknown> = {
        ...(input.process !== undefined ? { process: input.process } : {}),
        ...(input.titleContains !== undefined ? { titleContains: input.titleContains } : {}),
        element: { controlType: input.controlType, name: input.control },
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.keys !== undefined ? { keys: input.keys } : {}),
        ...(input.toControl !== undefined ? { to: { controlType: input.toControlType, name: input.toControl } } : {}),
        ...(input.direction !== undefined ? { direction: input.direction, amount: input.amount ?? 3 } : {}),
      };
      const { reply, error } = await callDaemon(bridge, tool, args, ctx, 55_000);
      const fail = (message: string, output?: unknown) => { prog.halted = true; return { ok: false, ...(output !== undefined ? { output } : {}), error: pre + message, evidence: "" }; };
      if (!reply) return fail(error!);
      if (reply.status === "cancelled") return fail("The request was cancelled. Nothing was done.");
      if (reply.status !== "ok") return fail(reply.error?.message ?? "The request was not approved. Nothing was done.");
      const r = reply.result ?? {};
      if (r.executed === true && r.verified === true) {
        prog.next += 1;
        const what = `${INPUT_LABEL[tool]} ${r.control?.controlType ?? "control"} "${r.control?.name || r.control?.automationId || ""}"${r.keys ? ` (${r.keys})` : ""}`;
        return { ok: true, output: r, evidence: `${pre}${what} in "${r.target?.title}" (${r.target?.process}). Verified by a fresh observation: ${r.observed}.` };
      }
      return fail("The input was not confirmed as performed and verified.", r);
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o || o.executed !== true || o.verified !== true) return { ok: false, reason: "the input was not performed and verified" };
      return { ok: true };
    },
    // Per-request progress ends with the run (also between the steps of a workflow, which share the daemon's task id).
    endTask(taskId) { inputProgress.delete(taskId); },
    requestCheck: inputCheck(tool, bridge),
  };
}

// ── "Open <any installed application>": the NAME the user said, resolved by the daemon (never a path, file or command) ──

const OPEN_ANY = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:open|launch)\s+(?:up\s+)?(?:the\s+|a\s+|an\s+)?([\p{L}\p{N}][\p{L}\p{N} +#&'.-]{0,59}?)(?:\s+(?:app|application|program))?\s*[.!?]?\s*$/iu;
/** Things that are not application names (they belong to other tools), and compound requests (refused rather than guessed). */
const NOT_AN_APP = [
  /^(?:my|your|this|that|it|folder|folders|directory|page|web\s*page|website|site|url|link|note|notes|workflow|workflows|document|documents|tab|new\s+tab)\b/i,
  /^files?\b(?!\s+explorer)/i,
  /^windows?$/i,
  /\b(?:and|then|settings|workflow|folder)\b/i,
  /\.[a-z0-9]{1,5}$/i,
  /[\\/:"]/,
];
/** The application name in "open <name>", or null. The daemon resolves it to exactly one installed application (or asks which). */
export function openAppRequest(o: string): string | null {
  const m = OPEN_ANY.exec(o);
  if (!m) return null;
  const name = m[1]!.trim();
  if (!name || NOT_AN_APP.some((re) => re.test(name))) return null;
  return name;
}

// ── "Open Chrome and search for X" / "open the folder D:\x in VS Code": an application WITH what to open in it ──

export interface OpenTargetRequest { app: string; search?: string; folder?: string }
const SEARCH_IN = /^\s*(?:please\s+)?(?:open|launch)\s+(?:the\s+)?([\p{L}][\p{L} ]{1,29}?)\s+and\s+search\s+(?:the\s+web\s+)?(?:for\s+)?(?:["“]([^"”]{1,200})["”]|([^"”]{1,200}?))\s*[.!?]?\s*$/iu;
const FOLDER_IN = /^\s*(?:please\s+)?open\s+(?:the\s+|my\s+)?(?:folder|project|directory)\s+["“]?([A-Za-z]:\\[^"”\r\n]{0,200}?)["”]?\s+in\s+(?:the\s+)?([\p{L}][\p{L} ]{1,29}?)\s*[.!]?\s*$/iu;
const APP_ON_FOLDER = /^\s*(?:please\s+)?open\s+([\p{L}][\p{L} ]{1,29}?)\s+(?:with|on|in|at)\s+(?:the\s+|my\s+)?(?:folder|project|directory)\s+["“]?([A-Za-z]:\\[^"”\r\n]{0,200}?)["”]?\s*[.!]?\s*$/iu;
/** An application plus a web search or an existing-folder path, exactly as the request says them (the daemon validates both). */
export function openTargetRequest(o: string): OpenTargetRequest | null {
  let m = SEARCH_IN.exec(o);
  if (m) { const q = (m[2] ?? m[3] ?? "").trim(); return q ? { app: m[1]!.trim(), search: q } : null; }
  m = FOLDER_IN.exec(o);
  if (m) return { app: m[2]!.trim(), folder: m[1]!.trim() };
  m = APP_ON_FOLDER.exec(o);
  if (m) return { app: m[1]!.trim(), folder: m[2]!.trim() };
  return null;
}

// ── "Open Windows Settings [and navigate to] Display" / "open display settings" ──

const SETTINGS_A = /^\s*(?:please\s+)?(?:open|show|launch)\s+(?:the\s+|my\s+)?(?:windows\s+)?settings(?:\s+app)?(?:\s*(?:,|and)?\s*(?:then\s+)?(?:navigate|go|switch|take\s+me)\s+to\s+(?:the\s+)?([\p{L} &-]{2,40}?)(?:\s+(?:page|section|settings))?)?\s*[.!]?\s*$/iu;
const SETTINGS_B = /^\s*(?:please\s+)?(?:open|show)\s+(?:the\s+|my\s+)?(?:windows\s+)?([\p{L} &-]{2,40}?)\s+settings(?:\s+page)?\s*[.!]?\s*$/iu;
/** The Settings page the request names ("" = the Settings home page), or null. The daemon accepts only its fixed table of pages. */
export function settingsRequest(o: string): string | null {
  const a = SETTINGS_A.exec(o);
  if (a) return (a[1] ?? "").trim().toLowerCase();
  const b = SETTINGS_B.exec(o);
  return b ? b[1]!.trim().toLowerCase() : null;
}

const INSTALLED_APPS = /^\s*(?:please\s+)?(?:(?:list|show)(?:\s+me)?(?:\s+(?:all|my|the))*\s+installed\s+(?:apps|applications|programs)(?:\s+(?:named|called|matching)\s+([\p{L}\p{N} ]{1,40}))?|what\s+(?:apps|applications|programs)\s+(?:are|do\s+i\s+have)\s+installed)\s*[.!?]?\s*$/iu;
export const installedAppsRequest = (o: string): { filter: string | null } | null => {
  const m = INSTALLED_APPS.exec(o);
  return m ? { filter: m[1]?.trim() || null } : null;
};

// ── desktop.launch_app (open one known application, after approval; success only on a NEW window) ──

/** Tasks in which an application was opened AND confirmed (the daemon saw its new window): typing into it is allowed only then. */
const launchedTasks = new Set<string>();
const launchAsked = new Set<string>();

type LaunchInput = { app: string; search?: string; folder?: string };
function createLaunchAppTool(bridge: DesktopBridge): ToolSpec<LaunchInput, any> {
  const fixedMine = (o: string) => {
    const s = appSession(o);
    return s !== null && offered(bridge, "desktop.launch_app") && (s.text === null || offered(bridge, "desktop.type_text"));
  };
  /** Any other installed application, by the name the user said: only when the daemon offers its catalog of installed applications. */
  const catalog = () => offered(bridge, "desktop.launch_app") && offered(bridge, "desktop.list_apps");
  /** An application WITH a web search or a folder to open in it ("open Chrome and search for ...", "open the folder D:\x in VS Code"). */
  const targeted = (o: string): OpenTargetRequest | null => (catalog() ? openTargetRequest(o) : null);
  /** "Open github.com in Chrome" belongs to the Chrome tools when the daemon offers them (2026-11-14). */
  const chromeOwned = (o: string) => { const c = chromeRequest(o); return c !== null && offered(bridge, c.tool); };
  const generic = (o: string): string | null =>
    targeted(o) === null && appSession(o) === null && catalog() && !chromeOwned(o) ? openAppRequest(o) : null;
  const mine = (o: string) => fixedMine(o) || generic(o) !== null || targeted(o) !== null;
  const appOf = (o: string): string => (fixedMine(o) ? appSession(o)!.app : targeted(o)?.app ?? generic(o)!);
  /** Exactly what the request asks to open: the application name and, when given, its search or folder (all as the user said them). */
  const want = (o: string): LaunchInput => targeted(o) ?? { app: appOf(o) };
  const forbidden = (why: string) => ({ kind: "forbidden" as const, reason: why });
  const check: ToolRequestCheck<LaunchInput, any> = {
    argumentDomains: (o): Record<string, ArgumentDomain> => {
      if (!mine(o)) return { app: forbidden("the request does not ask to open an application") };
      const w = want(o);
      return {
        app: { kind: "enum", values: [w.app], optional: false },
        search: w.search !== undefined ? { kind: "enum", values: [w.search], optional: false } : forbidden("the request asks for no web search"),
        folder: w.folder !== undefined ? { kind: "enum", values: [w.folder], optional: false } : forbidden("the request names no folder"),
      };
    },
    relevant: mine,
    // The whole request ("open Notepad and type X") belongs to the launch and typing tools: no window listing or other tool may answer it.
    claims: mine,
    facets(o) {
      if (!mine(o)) return [];
      const t = targeted(o);
      if (t !== null) return [{ id: `app:launch:${t.app.toLowerCase()}:${t.search !== undefined ? "search" : "folder"}`, tool: "desktop.launch_app",
        description: t.search !== undefined ? `open ${t.app} and search for "${t.search}"` : `open ${t.folder} in ${t.app}`, data: { ...t } }];
      const g = generic(o);
      if (g !== null) return [{ id: `app:launch:${g.toLowerCase()}`, tool: "desktop.launch_app", description: `open ${g}`, data: { app: g } }];
      const withText = appSession(o)!.text !== null;
      const app = appSession(o)!.app;
      return [{ id: `app:launch:${app}`, tool: "desktop.launch_app", description: `open ${LAUNCHABLE[app].name}`, data: { app },
        ...(withText ? { sequence: { key: "input-steps", index: 0, of: 2 } } : {}) }];
    },
    ground: (input, o) => {
      if (!mine(o)) return ungrounded("the request does not ask to open an application");
      const w = want(o);
      if (input.app !== w.app) return contradicted(`the request names ${w.app}`);
      if ((input.search ?? undefined) !== w.search) return contradicted(w.search !== undefined ? `the request searches for "${w.search}"` : "the request asks for no web search");
      if ((input.folder ?? undefined) !== w.folder) return contradicted(w.folder !== undefined ? `the request names the folder ${w.folder}` : "the request names no folder");
      return grounded("the application (and what to open in it) are the ones the request names");
    },
    // Satisfied only when the daemon opened the application AND a fresh look at the desktop showed its window (showing the search/folder).
    satisfies: (f, input, outcome) => {
      const d = f.data as LaunchInput;
      return outcome.ok && outcome.output?.launched === true && outcome.output?.verified === true && input.app === d.app &&
        (input.search ?? undefined) === d.search && (input.folder ?? undefined) === d.folder;
    },
    stepFor: (f, o) => (f.tool === "desktop.launch_app" && mine(o) ? want(o) : null),
    // The request dictates the order: the launch first (exactly one), then whatever else was planned, and the typing step the request
    // spells out if the model left it out. The model's own values are kept for the steps it proposed (they are validated against the
    // request like always); the steps added here carry only values taken from the request text.
    arrangeSteps(steps, o) {
      const g = generic(o) ?? targeted(o)?.app ?? null;
      if (g !== null) {
        // "open <name>" (with its search or folder) is exactly one launch: nothing else the model may have added belongs to it.
        const launch = steps.find((x) => x.tool === "desktop.launch_app") ?? { id: "app_open", description: `open ${g}`, tool: "desktop.launch_app", input: want(o) };
        return [{ ...launch, dependsOn: undefined }];
      }
      const s = appSession(o);
      if (!s || !fixedMine(o)) return steps;
      const launch = steps.find((x) => x.tool === "desktop.launch_app") ?? { id: "app_open", description: `open ${LAUNCHABLE[s.app].name}`, tool: "desktop.launch_app", input: { app: s.app } };
      // The whole request is the session: only its launch and its typing belong in the plan (any other step the model added is dropped).
      const rest = steps.filter((x) => x.tool === "desktop.type_text");
      const needsType = s.text !== null && !rest.some((x) => x.tool === "desktop.type_text");
      const typing = needsType
        ? [{ id: "app_type", description: "type the text into Notepad", tool: "desktop.type_text", input: { process: "notepad.exe", controlType: APP_EDITOR.controlType, control: APP_EDITOR.name, text: s.text! } }] : [];
      return [{ ...launch, dependsOn: undefined }, ...rest.map((x) => ({ ...x, dependsOn: undefined })), ...typing];
    },
    vocabulary: (o) => ["open", "launch", "start", "run", "up", "notepad", "calculator", "calc", "character", "map", "charmap", "app", "application", "program", "window", "type", "write", "enter", "in", "into", "it", "then", "and", "please", "the", "a", "an",
      ...contentWords(generic(o) ?? ""), ...contentWords(targeted(o)?.app ?? ""), ...contentWords(targeted(o)?.search ?? ""), "search", "for", "web", "folder", "project", "directory", "with", "on", "at", "my"],
  };
  return {
    name: "desktop.launch_app",
    description: "Ask the user (in the HUD) to approve OPENING one installed application. app is exactly the application NAME the request says (e.g. \"Microsoft Word\", \"chrome\", \"notepad\"); never a path, file or command. The daemon resolves the name to one installed application, starts it once and confirms its window.",
    inputSchema: { type: "object", properties: {
      app: { type: "string", minLength: 1, maxLength: 80 },
      search: { type: "string", minLength: 1, maxLength: 200, description: "only when the request asks to search the web in a browser: the words exactly as said" },
      folder: { type: "string", minLength: 3, maxLength: 200, description: "only when the request names a folder to open (e.g. in VS Code): the path exactly as said" },
    }, required: ["app"] },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 75_000,
    async execute(input, ctx) {
      if (launchAsked.has(ctx.taskId)) return { ok: false, error: "Already asked to open an application in this task; not asking again.", evidence: "" };
      launchAsked.add(ctx.taskId);
      const { reply, error } = await callDaemon(bridge, "desktop.launch_app",
        { app: input.app, ...(input.search !== undefined ? { search: input.search } : {}), ...(input.folder !== undefined ? { folder: input.folder } : {}) }, ctx, 70_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status === "cancelled") return { ok: false, error: "The request was cancelled. Nothing was opened.", evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "The request was not approved. Nothing was opened.", evidence: "" };
      const r = reply.result ?? {};
      if (r.launched === true && r.verified === true) {
        launchedTasks.add(ctx.taskId);
        return { ok: true, output: r, evidence: `Opened ${LAUNCHABLE[input.app as AppKey]?.name ?? r.app ?? input.app}: ${r.observed}. Verified by a fresh look at the desktop after the approved start.` };
      }
      return { ok: false, output: r, error: "The launch was not confirmed.", evidence: "" };
    },
    check(_input, outcome) {
      const o = outcome.output;
      return o && o.launched === true && o.verified === true ? { ok: true } : { ok: false, reason: "the launch was not confirmed by a new window" };
    },
    endTask(taskId) { launchedTasks.delete(taskId); launchAsked.delete(taskId); },
    requestCheck: check,
  };
}

// ── desktop.read_text (vision: offline OCR of one named window, read-only) ──

function createReadTextTool(bridge: DesktopBridge): ToolSpec<{ process?: string; titleContains?: string }, any> {
  const check: ToolRequestCheck<{ process?: string; titleContains?: string }, any> = {
    argumentDomains: (o) => (isReadTextRequest(o) ? domains(o) : {}),
    relevant: (o) => READ_TEXT_INTENT.test(o) && offered(bridge, "desktop.read_text"),
    // "Read the text in the window titled X" is about a window, not a file: no file check may ask "which file?".
    claims: (o) => isReadTextRequest(o) && offered(bridge, "desktop.read_text"),
    facets: (o) => (isReadTextRequest(o) && offered(bridge, "desktop.read_text")
      ? [{ id: `read-text:${requestedProcess(o) ?? "*"}:${requestedTitle(o) ?? "*"}`, tool: "desktop.read_text", description: "read the text the named window shows", data: null }] : []),
    ground: (i, o) => (isReadTextRequest(o) ? selectorMatches(i, o) : ungrounded("the request does not ask to read a window's text")),
    // Satisfied when the daemon recognised the named window's text (an empty window yields zero lines, still an answer).
    satisfies: (_f, _i, outcome) => outcome.ok && Array.isArray(outcome.output?.lines) && !outcome.output?.truncated,
    vocabulary: (o) => [...VOCAB, "read", "ocr", "extract", "transcribe", "text", "words", "writing", "contents", "content", "does", "do", "say", "says", "of", "in", "what", ...appWords(o)],
  };
  return {
    name: "desktop.read_text",
    description: "Read the text ONE window the user names shows on screen (offline text recognition; read-only). Give process and/or titleContains exactly as the request names them.",
    inputSchema: { type: "object", properties: { process: { type: "string", minLength: 1, maxLength: 64 }, titleContains: { type: "string", minLength: 1, maxLength: 100 } } },
    permissions: ["read:desktop"], risk: "low", requiresApproval: false, timeoutMs: 25_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "desktop.read_text", { ...input }, ctx, 22_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "The window's text could not be read.", evidence: "" };
      const r = reply.result ?? {};
      const lines = (r.lines ?? []) as { text: string }[];
      return { ok: true, output: r, evidence: `Text recognised offline in "${r.window?.title}" (${r.window?.process}), ${lines.length} line(s)${r.truncated ? ", truncated" : ""}; recognised text can contain errors:\n${lines.map((l) => l.text).join("\n")}` };
    },
    check: (_i, o) => (Array.isArray(o.output?.lines) ? { ok: true } : { ok: false, reason: "no recognised text in the output" }),
    requestCheck: check,
  };
}

// ── desktop.open_settings (one Windows Settings page from the daemon's fixed table; low risk: no approval card, audited, gated) ──

function createOpenSettingsTool(bridge: DesktopBridge): ToolSpec<{ page: string }, any> {
  const mine = (o: string) => offered(bridge, "desktop.open_settings") && settingsRequest(o) !== null;
  return {
    name: "desktop.open_settings",
    description: "Open Windows Settings at one page the request names (e.g. \"display\", \"sound\", \"bluetooth\"; \"\" for the Settings home page). Shows settings; changes none. The daemon confirms the page is on screen.",
    inputSchema: { type: "object", properties: { page: { type: "string", maxLength: 40 } }, required: ["page"] },
    permissions: ["request:desktop_action"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 25_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "desktop.open_settings", { page: input.page }, ctx, 22_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Windows Settings was not opened.", evidence: "" };
      const r = reply.result ?? {};
      return r.opened === true && r.verified === true
        ? { ok: true, output: r, evidence: `Opened Windows Settings at ${r.page}: ${r.observed}.` }
        : { ok: false, output: r, error: "Opening Windows Settings was not confirmed.", evidence: "" };
    },
    check: (_i, outcome) => (outcome.output?.opened === true && outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the Settings page was not confirmed on screen" }),
    requestCheck: {
      argumentDomains: (o) => ({ page: mine(o) ? { kind: "enum", values: [settingsRequest(o)!], optional: false } : { kind: "forbidden", reason: "the request does not ask for Windows Settings" } }),
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: `settings:${settingsRequest(o)}`, tool: "desktop.open_settings", description: `open Windows Settings${settingsRequest(o) ? ` at ${settingsRequest(o)}` : ""}`, data: { page: settingsRequest(o) } }] : []),
      ground: (input, o) => (!mine(o) ? ungrounded("the request does not ask for Windows Settings")
        : input.page === settingsRequest(o) ? grounded("the page is the one the request names") : contradicted(`the request names the page "${settingsRequest(o)}"`)),
      satisfies: (f, input, outcome) => outcome.ok && outcome.output?.verified === true && input.page === (f.data as { page: string }).page,
      stepFor: (f, o) => (f.tool === "desktop.open_settings" && mine(o) ? { page: settingsRequest(o)! } : null),
      vocabulary: (o) => ["open", "show", "launch", "windows", "settings", "app", "and", "then", "navigate", "go", "switch", "take", "me", "to", "the", "my", "page", "section", "please",
        ...contentWords(settingsRequest(o) ?? "")],
    },
  };
}

// ── office.create_word_document / office.create_excel_workbook (a NEW file in Documents with exactly the approved content) ──

const DOC_NAME = String.raw`["“]?([\p{L}\p{N}][\p{L}\p{N} _().,'&-]{0,79}?)["”]?`;
const WORD_REQ = new RegExp(String.raw`^\s*(?:please\s+)?(?:create|make|write)\s+(?:a\s+)?(?:new\s+)?(?:word\s+document|document\s+in\s+word)\s+(?:named|called|titled)\s+${DOC_NAME}\s+(?:with|containing)\s+(?:the\s+)?(?:heading\s+["“]([^"”]{1,200})["”]\s+and\s+(?:the\s+)?)?(?:text|paragraph)\s+["“]([^"”]{1,2000})["”]\s*[.!]?\s*$`, "iu");
const EXCEL_REQ = new RegExp(String.raw`^\s*(?:please\s+)?(?:create|make)\s+(?:an?\s+)?(?:new\s+)?excel\s+(?:workbook|spreadsheet)\s+(?:named|called|titled)\s+${DOC_NAME}\s+with\s+(?:the\s+)?rows?\s*:?\s+(.{1,4000}?)\s*[.!]?\s*$`, "iu");
export interface WordRequest { name: string; heading: boolean; paragraphs: string[] }
export interface ExcelRequest { name: string; rows: string[][] }
export function wordDocumentRequest(o: string): WordRequest | null {
  const m = WORD_REQ.exec(o);
  if (!m) return null;
  return m[2] !== undefined ? { name: m[1]!.trim(), heading: true, paragraphs: [m[2]!.trim(), m[3]!.trim()] } : { name: m[1]!.trim(), heading: false, paragraphs: [m[3]!.trim()] };
}
/** Rows separated by ";", cells by "," — exactly as said ("Item, Cost; Laptop, 1200"). */
export function excelWorkbookRequest(o: string): ExcelRequest | null {
  const m = EXCEL_REQ.exec(o);
  if (!m) return null;
  const rows = m[2]!.split(";").map((r) => r.split(",").map((c) => c.trim())).filter((r) => r.some((c) => c.length > 0));
  return rows.length ? { name: m[1]!.trim(), rows } : null;
}

function createOfficeTool(bridge: DesktopBridge, tool: "office.create_word_document" | "office.create_excel_workbook"): ToolSpec<any, any> {
  const word = tool === "office.create_word_document";
  const req = (o: string) => (offered(bridge, tool) ? (word ? wordDocumentRequest(o) : excelWorkbookRequest(o)) : null);
  const mine = (o: string) => req(o) !== null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    name: tool,
    description: word
      ? "Create a NEW Word document in the user's Documents folder with exactly the paragraphs the request quotes (optionally a bold heading first). The user approves the exact file and text; the saved file is read back and checked."
      : "Create a NEW Excel workbook in the user's Documents folder with exactly the rows the request gives (first row a bold header). The user approves the exact file and cells; the saved file is read back and checked.",
    inputSchema: word
      ? { type: "object", properties: { name: { type: "string", maxLength: 80 }, heading: { type: "boolean" }, paragraphs: { type: "array", items: { type: "string" }, maxItems: 50 } }, required: ["name", "paragraphs"] }
      : { type: "object", properties: { name: { type: "string", maxLength: 80 }, rows: { type: "array", items: { type: "array", items: { type: "string" } }, maxItems: 200 } }, required: ["name", "rows"] },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 200_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, tool, input, ctx, 195_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was created.", evidence: "" };
      const r = reply.result ?? {};
      return r.created === true && r.verified === true
        ? { ok: true, output: r, evidence: `Created ${r.file}: ${r.observed}.` }
        : { ok: false, output: r, error: "The file was not confirmed.", evidence: "" };
    },
    check: (_i, outcome) => (outcome.output?.created === true && outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the saved file was not confirmed" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        if (!r) return { name: { kind: "forbidden", reason: `the request does not ask for a new ${word ? "Word document" : "Excel workbook"}` } };
        return word
          ? { name: { kind: "enum", values: [r.name], optional: false }, heading: { kind: "enum", values: [(r as WordRequest).heading] as any, optional: true } }
          : { name: { kind: "enum", values: [r.name], optional: false } };
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: `${tool}:${req(o)!.name}`, tool, description: `create ${req(o)!.name}${word ? ".docx" : ".xlsx"}`, data: req(o)! }] : []),
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask for this document");
        if (input.name !== r.name) return contradicted(`the request names the file "${r.name}"`);
        if (word) {
          const w = r as WordRequest;
          return same(input.paragraphs, w.paragraphs) && (input.heading ?? false) === w.heading ? grounded("the text is exactly the request's") : contradicted("write exactly the quoted text");
        }
        return same(input.rows, (r as ExcelRequest).rows) ? grounded("the cells are exactly the request's") : contradicted("write exactly the rows the request gives");
      },
      satisfies: (f, input, outcome) => outcome.ok && outcome.output?.verified === true && input.name === (f.data as { name: string }).name,
      stepFor: (f, o) => (f.tool === tool && mine(o) ? { ...req(o)! } : null),
      vocabulary: (o) => ["create", "make", "write", "a", "an", "new", "word", "document", "excel", "workbook", "spreadsheet", "named", "called", "titled", "with", "containing",
        "the", "heading", "and", "text", "paragraph", "row", "rows", "in", "please", ...contentWords(JSON.stringify(req(o) ?? ""))],
    },
  };
}

// ── dev.run_task: build or test ONE project folder the request names (the daemon picks the command; the user approves it) ──

const DEV_TEST = /^\s*(?:please\s+)?(?:run\s+(?:the\s+)?tests?\s+(?:in|of|for)|test)\s+(?:the\s+)?(?:project\s+|folder\s+)?["“]?([A-Za-z]:\\[^"”\r\n]{0,200}?)["”]?\s*[.!]?\s*$/i;
const DEV_BUILD = /^\s*(?:please\s+)?(?:build|compile)\s+(?:the\s+)?(?:project\s+|folder\s+|code\s+in\s+)?["“]?([A-Za-z]:\\[^"”\r\n]{0,200}?)["”]?\s*[.!]?\s*$/i;
export function devTaskRequest(o: string): { folder: string; task: "build" | "test" } | null {
  let m = DEV_TEST.exec(o);
  if (m) return { folder: m[1]!.trim(), task: "test" };
  m = DEV_BUILD.exec(o);
  return m ? { folder: m[1]!.trim(), task: "build" } : null;
}

function createDevTaskTool(bridge: DesktopBridge): ToolSpec<{ folder: string; task: string }, any> {
  const req = (o: string) => (offered(bridge, "dev.run_task") ? devTaskRequest(o) : null);
  return {
    name: "dev.run_task",
    description: "Build, or run the tests of, ONE project folder the request names (full path). D-ASK recognises the project (.NET, npm, Cargo) and chooses the command; the user approves it in the HUD; the exit code, error lines and test summary are reported so a failure can be explained.",
    inputSchema: { type: "object", properties: { folder: { type: "string", minLength: 3, maxLength: 260 }, task: { type: "string", enum: ["build", "test"] } }, required: ["folder", "task"] },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 720_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "dev.run_task", { folder: input.folder, task: input.task }, ctx, 715_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was run.", evidence: "" };
      const r = reply.result ?? {};
      const lines = [`${r.command} in ${r.folder}: ${r.observed} (${Math.round((r.durationMs ?? 0) / 1000)} s).`,
        r.summary?.length ? `Summary: ${r.summary.join(" | ")}` : "",
        r.errors?.length ? `Errors found in the output:\n${r.errors.slice(0, 15).map((e: string) => `- ${e}`).join("\n")}` : ""].filter(Boolean).join("\n");
      // A FAILED build/test is still a completed, verified run: the request asked to run it and report what happened.
      return r.verified === true ? { ok: true, output: r, evidence: lines } : { ok: false, output: r, error: lines || "The run did not finish.", evidence: "" };
    },
    check: (_i, outcome) => (outcome.output?.executed === true && outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the run did not finish with an exit code" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        return r ? { folder: { kind: "enum", values: [r.folder], optional: false }, task: { kind: "enum", values: [r.task], optional: false } }
                 : { folder: { kind: "forbidden", reason: "the request does not ask to build or test a named project folder" } };
      },
      relevant: (o) => req(o) !== null,
      claims: (o) => req(o) !== null,
      facets: (o) => { const r = req(o); return r ? [{ id: `dev:${r.task}:${r.folder.toLowerCase()}`, tool: "dev.run_task", description: `${r.task} ${r.folder}`, data: r }] : []; },
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask to build or test a project");
        return input.folder === r.folder && input.task === r.task ? grounded("the folder and the task are the request's") : contradicted(`${r.task} exactly ${r.folder}`);
      },
      satisfies: (f, input, outcome) => outcome.ok && outcome.output?.verified === true && input.folder === (f.data as { folder: string }).folder,
      stepFor: (f, o) => (f.tool === "dev.run_task" && req(o) ? { ...req(o)! } : null),
      vocabulary: (o) => ["run", "the", "test", "tests", "in", "of", "for", "build", "compile", "project", "folder", "code", "please", ...contentWords(req(o)?.folder ?? "")],
    },
  };
}

// ── desktop.list_apps (read-only: the applications Windows registers) ──

function createListAppsTool(bridge: DesktopBridge): ToolSpec<{ filter?: string }, any> {
  const mine = (o: string) => offered(bridge, "desktop.list_apps") && installedAppsRequest(o) !== null;
  return {
    name: "desktop.list_apps",
    description: "List the applications installed on this computer (read-only), optionally only those whose name contains the words the request gives.",
    inputSchema: { type: "object", properties: { filter: { type: "string", maxLength: 40 } } },
    permissions: ["read:desktop"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 15_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, "desktop.list_apps", input.filter ? { filter: input.filter } : {}, ctx, 12_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "The installed applications could not be listed.", evidence: "" };
      const r = reply.result ?? {};
      const names: string[] = (r.apps ?? []).map((a: { name: string }) => a.name);
      return { ok: true, output: r, evidence: `${r.shown} of ${r.count} installed applications${input.filter ? ` matching "${input.filter}"` : ""}:\n${names.map((n) => `• ${n}`).join("\n")}` };
    },
    check: (_i, outcome) => (typeof outcome.output?.count === "number" ? { ok: true } : { ok: false, reason: "no list" }),
    requestCheck: {
      argumentDomains: (o) => {
        const r = installedAppsRequest(o);
        return { filter: r?.filter ? { kind: "enum", values: [r.filter], optional: false } : { kind: "forbidden", reason: "the request gives no filter" } };
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: "apps:list", tool: "desktop.list_apps", description: "list the installed applications", data: { filter: installedAppsRequest(o)!.filter } }] : []),
      ground: (input, o) => (!mine(o) ? ungrounded("not a request to list installed applications")
        : (input.filter ?? null) === installedAppsRequest(o)!.filter ? grounded("the filter is the request's") : contradicted("use exactly the request's filter")),
      satisfies: (_f, _i, outcome) => outcome.ok && typeof outcome.output?.count === "number",
      stepFor: (f, o) => (f.tool === "desktop.list_apps" && mine(o) ? (installedAppsRequest(o)!.filter ? { filter: installedAppsRequest(o)!.filter! } : {}) : null),
      vocabulary: (o) => ["list", "show", "me", "all", "my", "the", "installed", "apps", "applications", "programs", "what", "are", "do", "i", "have", "named", "called", "matching", "please",
        ...contentWords(installedAppsRequest(o)?.filter ?? "")],
    },
  };
}

export const createDesktopTools = (bridge: DesktopBridge): ToolSpec<any, any>[] => [
  createListWindowsTool(bridge), createInspectWindowTool(bridge),
  createWindowActionTool(bridge, "desktop.focus_window"), createWindowActionTool(bridge, "desktop.set_window_state"),
  createInputTool(bridge, "desktop.click_element"), createInputTool(bridge, "desktop.type_text"), createInputTool(bridge, "desktop.press_keys"),
  // Vision (appended: the order of the earlier tools is unchanged).
  createReadTextTool(bridge),
  // Application launch (appended: the order of the earlier tools is unchanged).
  createLaunchAppTool(bridge),
  // Universal application control (appended): Windows Settings pages, and the installed applications.
  createOpenSettingsTool(bridge), createListAppsTool(bridge),
  // Office (appended): a new Word document / Excel workbook with exactly the approved content.
  createOfficeTool(bridge, "office.create_word_document"), createOfficeTool(bridge, "office.create_excel_workbook"),
  // Developer tasks (appended): build or test one project folder.
  createDevTaskTool(bridge),
  // Complete desktop input (appended 2026-11-14): right/double click, scroll, drag and drop, text selection; clipboard.
  createInputTool(bridge, "desktop.right_click_element"), createInputTool(bridge, "desktop.double_click_element"), createInputTool(bridge, "desktop.scroll"),
  createInputTool(bridge, "desktop.drag_element"), createInputTool(bridge, "desktop.select_text"),
  createClipboardTool(bridge, "desktop.clipboard_write"), createClipboardTool(bridge, "desktop.clipboard_read"),
];

// ── desktop.clipboard_write / desktop.clipboard_read (each approved in the HUD; the daemon verifies a write by reading it back) ──

const CLIP_WRITE = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:copy|put|place|set)\s+["“'‘]([^"”'’]{1,4000})["”'’]\s+(?:to|on|onto|in|into)\s+(?:the\s+|my\s+)?clipboard\s*[.!]?\s*$/i;
const CLIP_READ = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:(?:read|show|tell|paste)\s+(?:me\s+)?(?:what(?:'s|\s+is)\s+(?:on|in)\s+)?(?:the\s+|my\s+)?clipboard|what(?:'s|\s+is)\s+(?:on|in)\s+(?:the\s+|my\s+)?clipboard)\s*[.!?]?\s*$/i;
export function clipboardRequest(o: string): { tool: "desktop.clipboard_write"; text: string } | { tool: "desktop.clipboard_read" } | null {
  const w = CLIP_WRITE.exec(o);
  if (w) return { tool: "desktop.clipboard_write", text: w[1]! };
  return CLIP_READ.test(o) ? { tool: "desktop.clipboard_read" } : null;
}

function createClipboardTool(bridge: DesktopBridge, tool: "desktop.clipboard_write" | "desktop.clipboard_read"): ToolSpec<{ text?: string }, any> {
  const req = (o: string) => { const r = offered(bridge, tool) ? clipboardRequest(o) : null; return r && r.tool === tool ? r : null; };
  const mine = (o: string) => req(o) !== null;
  const write = tool === "desktop.clipboard_write";
  return {
    name: tool,
    description: write ? "Put the exact quoted text on the Windows clipboard (approved in the HUD; verified by reading it back)."
      : "Read the text on the Windows clipboard (approved in the HUD; secret-looking text is withheld).",
    inputSchema: write ? { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["text"] } : { type: "object", properties: {} },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 60_000,
    async execute(input, ctx) {
      const { reply, error } = await callDaemon(bridge, tool, write ? { text: input.text } : {}, ctx, 55_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was done.", evidence: "" };
      const r = reply.result ?? {};
      if (r.verified !== true) return { ok: false, output: r, error: "The clipboard operation was not confirmed.", evidence: "" };
      return write ? { ok: true, output: r, evidence: `Put ${r.textLength} character(s) on the clipboard: ${r.observed}.` }
        : { ok: true, output: r, evidence: r.hasText ? `The clipboard holds ${r.length} character(s)${r.truncated ? " (first part shown)" : ""}:\n${r.text}` : "The clipboard holds no text." };
    },
    check: (_i, outcome) => (outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the clipboard operation was not confirmed" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        return write ? { text: r && "text" in r ? { kind: "enum", values: [r.text], optional: false } : { kind: "forbidden", reason: "the request quotes no text for the clipboard" } } : {};
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: tool, tool, description: write ? "put the text on the clipboard" : "read the clipboard", data: req(o) }] : []),
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask for the clipboard");
        if (write && "text" in r && input.text !== r.text) return contradicted("use exactly the quoted text");
        return grounded("the clipboard operation is the request's");
      },
      satisfies: (_f, _i, outcome) => outcome.ok && outcome.output?.verified === true,
      stepFor: (f, o) => { const r = req(o); return f.tool === tool && r ? ("text" in r ? { text: r.text } : {}) : null; },
      vocabulary: (o) => ["copy", "put", "place", "set", "to", "on", "onto", "in", "into", "the", "my", "clipboard", "read", "show", "tell", "me", "paste", "what", "what's", "is", "please",
        ...contentWords((req(o) as { text?: string } | null)?.text ?? "")],
    },
  };
}
export type DesktopOutcome = ToolOutcome<unknown>;
