// ─────────────────────────────────────────────────────────────────────────────
// Phase 7B.1b: read-only desktop tools. The tools only ask the daemon; every Windows API call, every identity and
// every validation happens there. The agent can name a window (an application or part of a title taken from the
// user's request) but can never supply a window handle, a process id, a session or an approval. Nothing here can
// click, type, focus, resize, launch or close anything.
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import { requestedBrowserActions } from "./browserActions";
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

export interface InputActionRequest {
  tool: "desktop.click_element" | "desktop.type_text" | "desktop.press_keys";
  text: string | null;
  keys: string | null;
  target: string;
  /** The UI Automation control type the request's noun names ("button" -> Button, "field" -> Edit, ...). */
  controlType: string;
}

const CONTROL_NOUN = "(button|checkbox|check box|link|tab|menu item|radio button|field|text box|textbox|edit box|box|input)";
const POLITE = "^\\s*(?:please\\s+|can you\\s+|could you\\s+)?";
const CLICK_REQ = new RegExp(`${POLITE}click\\s+(?:on\\s+)?(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const TYPE_REQ = new RegExp(`${POLITE}(?:type|enter|write)\\s+["“'‘]([^"”'’]{1,200})["”'’]\\s+(?:into|in)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const KEY_TOKEN = "((?:(?:ctrl|control|shift)\\s*\\+\\s*)*(?:enter|tab|escape|esc|backspace|delete|space|up|down|left|right|home|end|page ?up|page ?down|f2|[acvxyz]))";
const PRESS_REQ = new RegExp(`${POLITE}press\\s+${KEY_TOKEN}\\s+(?:in|into|on)\\s+(?:the\\s+)?(.{1,60}?)\\s+${CONTROL_NOUN}\\b`, "i");
const NOUN_TYPE: Record<string, string> = {
  button: "Button", checkbox: "CheckBox", "check box": "CheckBox", link: "Hyperlink", tab: "TabItem", "menu item": "MenuItem",
  "radio button": "RadioButton", field: "Edit", "text box": "Edit", textbox: "Edit", "edit box": "Edit", box: "Edit", input: "Edit",
};
const typeOf = (noun: string) => NOUN_TYPE[noun.toLowerCase().replace(/\s+/g, " ")] ?? "Edit";
const INPUT_FORBIDDEN = /\b(double[- ]?click|right[- ]?click|drag|scroll|close|launch|kill|terminate|quit|shut ?down|uninstall|format)\b/i;
const QUOTED_ANY = /["“'‘][^"”'’]{1,200}["”'’]/g;
const SECOND_ACTION = /\b(?:and|then)\b\s+(?:then\s+)?(?:click|type|enter|write|press|minimi[sz]e|maximi[sz]e|restore|focus|bring|open|run|launch|close)\b/i;

/** Mirrors the daemon's allow-list (KeyChords.Allowed); the daemon re-validates every chord. */
const ALLOWED_CHORDS = new Set([
  "Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space", "Up", "Down", "Left", "Right", "Home", "End",
  "PageUp", "PageDown", "F2", "Ctrl+A", "Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Ctrl+Home", "Ctrl+End",
  "Shift+Home", "Shift+End", "Shift+Left", "Shift+Right",
]);
const KEY_NAMES: Record<string, string> = {
  enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: "Space",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", f2: "F2",
};

/** "ctrl + a" -> "Ctrl+A"; null if it is not an allowed chord. */
export function canonicalChord(raw: string): string | null {
  const parts = raw.split("+").map((p) => p.trim().toLowerCase().replace(/\s+/g, ""));
  let ctrl = false, shift = false, key: string | null = null;
  for (const p of parts) {
    if (p === "ctrl" || p === "control") { if (ctrl) return null; ctrl = true; }
    else if (p === "shift") { if (shift) return null; shift = true; }
    else if (key === null) key = KEY_NAMES[p] ?? (/^[acvxyz]$/.test(p) ? p.toUpperCase() : null);
    else return null;
    if (key === null && p !== "ctrl" && p !== "control" && p !== "shift") return null;
  }
  if (!key) return null;
  const c = (ctrl ? "Ctrl+" : "") + (shift ? "Shift+" : "") + key;
  return ALLOWED_CHORDS.has(c) ? c : null;
}

/** The daemon's per-task input budget (AgentHostDesktopCalls.MaxInputRequestsPerTask): each step is approved separately. */
export const MAX_INPUT_STEPS = 6;

const INPUT_VERB = "(?:click|type|enter|write|press)";
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

function parseInputStep(seg: string, previous: InputActionRequest | null): InputActionRequest | null {
  let m = TYPE_REQ.exec(seg);
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
interface InputArgs { process?: string; titleContains?: string; controlType?: string; control?: string; text?: string; keys?: string }

const offered = (b: DesktopBridge, tool: string): boolean => (b.offers ? b.offers(tool) : true);
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))];

/** Whether the planned arguments are exactly this requested step (tool, control, and its text or keys). */
function isStep(tool: string, input: InputArgs, a: InputActionRequest): boolean {
  return a.tool === tool && input.controlType === a.controlType && input.control === a.target &&
    (input.text ?? null) === a.text && (input.keys ?? null) === a.keys;
}

const verbOf = (a: InputActionRequest) => a.tool === "desktop.click_element" ? "click" : a.tool === "desktop.type_text" ? "type into" : `press ${a.keys} in`;

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
      if (tool === "desktop.press_keys") d.keys = own.length ? { kind: "enum", values: uniq(own.map((a) => a.keys)), optional: false } : { kind: "forbidden", reason: "the request names no allowed key" };
      return d;
    },
    relevant: (o) => mine(o),
    clarify: (o) => (mine(o) && !requestedProcess(o) && !requestedTitle(o)
      ? "Which window do you mean? Quote its title (\"… in the window titled '…'\") or name the application. I won't pick a window for you."
      : null),
    facets(objective) {
      if (!mine(objective)) return [];
      const p = requestedProcess(objective);
      const t = requestedTitle(objective);
      if (!p && !t) return [];
      const steps = stepsOf(objective);
      const out: RequestFacet[] = [];
      steps.forEach((a, i) => {
        if (a.tool !== tool) return;
        const data = { target: a.target, controlType: a.controlType, text: a.text, keys: a.keys };
        out.push(steps.length === 1
          ? { id: `desktop:input:${tool}:${p ?? "*"}:${t ?? "*"}`, tool, description: `${verbOf(a)} the ${a.target} control`, data }
          : { id: `desktop:input:${i + 1}of${steps.length}:${tool}:${p ?? "*"}:${t ?? "*"}`, tool, description: `input ${i + 1} of ${steps.length}: ${verbOf(a)} the ${a.target} control`,
              data, sequence: { key: "input-steps", index: i, of: steps.length } });
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
      const d = facet.data as { target: string; controlType: string; text: string | null; keys: string | null };
      return outcome.ok && !!o && o.executed === true && o.verified === true &&
        isStep(tool, input, { tool, target: d.target, controlType: d.controlType, text: d.text, keys: d.keys });
    },
    identicalStepsAllowed: (input, objective) => stepsOf(objective).filter((a) => isStep(tool, input as InputArgs, a)).length,
    stepFor(facet, objective) {
      if (facet.tool !== tool || !facet.sequence || !mine(objective)) return null;
      const a = stepsOf(objective)[facet.sequence.index];
      const p = requestedProcess(objective);
      const t = requestedTitle(objective);
      if (!a || a.tool !== tool || (!p && !t)) return null;
      const input: InputArgs = { ...(p ? { process: p } : {}), ...(t ? { titleContains: t } : {}), controlType: a.controlType, control: a.target,
        ...(a.text != null ? { text: a.text } : {}), ...(a.keys != null ? { keys: a.keys } : {}) };
      return this.ground(input, objective).status === "grounded" ? (input as Record<string, unknown>) : null;
    },
    vocabulary: (objective) => {
      const steps = requestedInputActions(objective);
      return [...VOCAB, "click", "on", "type", "enter", "write", "press", "into", "in", "field", "box", "textbox", "text", "edit", "input",
        "button", "checkbox", "check", "link", "tab", "menu", "item", "radio", "ctrl", "control", "shift", "esc", "escape", "backspace", "delete",
        "space", "up", "down", "left", "right", "home", "end", "page", "pageup", "pagedown", "then", "and", "again", "there", "too",
        ...steps.flatMap((a) => [...contentWords(a.target), ...contentWords(a.text ?? ""), ...contentWords(a.keys?.replace(/\+/g, " ") ?? "")]),
        ...appWords(objective)];
    },
  };
}

const INPUT_LABEL: Record<InputActionRequest["tool"], string> = {
  "desktop.click_element": "Clicked", "desktop.type_text": "Typed the text into", "desktop.press_keys": "Pressed the keys in",
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
    description: tool === "desktop.click_element"
      ? "Ask the user (in the HUD) to approve ONE left click on one control of a window they named. Give process and/or titleContains from the request, and element {controlType, automationId or name} exactly as desktop.inspect_window lists it. Never coordinates."
      : tool === "desktop.type_text"
        ? "Ask the user (in the HUD) to approve typing the exact quoted text into one text field of a window they named. Give the window selector, element {controlType, automationId or name} from desktop.inspect_window, and text."
        : "Ask the user (in the HUD) to approve pressing ONE allowed key chord (e.g. Enter, Tab, Ctrl+A) in one control of a window they named. Give the window selector, element from desktop.inspect_window, and keys.",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", minLength: 1, maxLength: 64 },
        titleContains: { type: "string", minLength: 1, maxLength: 100 },
        controlType: { type: "string", minLength: 1, maxLength: 40 },
        control: { type: "string", minLength: 1, maxLength: 200 },
        ...(tool === "desktop.type_text" ? { text: { type: "string", minLength: 1, maxLength: 200 } } : {}),
        ...(tool === "desktop.press_keys" ? { keys: { type: "string", minLength: 1, maxLength: 32 } } : {}),
      },
      required: ["controlType", "control", ...(tool === "desktop.type_text" ? ["text"] : tool === "desktop.press_keys" ? ["keys"] : [])],
    },
    // Only to REQUEST input. The daemon owns the target, the approval, the per-event gates and the verification.
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 60_000,
    async execute(input, ctx) {
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

export const createDesktopTools = (bridge: DesktopBridge) => [
  createListWindowsTool(bridge), createInspectWindowTool(bridge),
  createWindowActionTool(bridge, "desktop.focus_window"), createWindowActionTool(bridge, "desktop.set_window_state"),
  createInputTool(bridge, "desktop.click_element"), createInputTool(bridge, "desktop.type_text"), createInputTool(bridge, "desktop.press_keys"),
  // Vision (appended: the order of the earlier tools is unchanged).
  createReadTextTool(bridge),
];
export type DesktopOutcome = ToolOutcome<unknown>;
