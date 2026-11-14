// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// D-ASK agent-host protocol, version 1: JSON Lines over stdin/stdout.
//
//   request   {"v":1,"id":"<id>","op":"<op>","params":{...}}
//   response  {"v":1,"kind":"response","id":"<id>","ok":true,"result":{...}}
//             {"v":1,"kind":"response","id":"<id>"|null,"ok":false,"error":{"code":"...","message":"..."}}
//   event     {"v":1,"kind":"event","event":"task.progress"|"task.finished","requestId":"<submit id>","taskId":"...","seq":n,"data":{...}}
//
// Every request gets exactly one response carrying its id. `id` is null only when the
// line could not yield a valid id (malformed JSON, oversized line, invalid id).
// Validation is strict: unknown ops and unknown fields are rejected, never ignored,
// so the protocol cannot be used to smuggle grants, approvals or tool calls.
// There is deliberately no op that names a tool, a permission or an approval.
//
// Concurrency: requests are handled in arrival order and answered immediately;
// long work happens in the background and reports through events. At most one task
// runs at a time (one model slot); a second submit gets `busy`, not a queue.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const PROTOCOL_VERSION = 1;
/** Longest accepted input line, in bytes. */
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_OBJECTIVE_CHARS = 4_000;

export type ErrorCode =
  | "malformed_json"
  | "message_too_large"
  | "invalid_request"
  | "unsupported_version"
  | "unknown_op"
  | "invalid_params"
  | "not_authenticated"
  | "authentication_failed"
  | "already_authenticated"
  | "duplicate_task"
  | "busy"
  | "unknown_task"
  | "emergency_stopped"
  | "stale_generation"
  | "shutting_down"
  | "internal_error";

export type Op = "hello" | "health" | "submit" | "status" | "cancel" | "emergency_stop" | "resume" | "shutdown";

export interface HelloParams {
  token: string;
  emergencyStopped: boolean;
  stopGeneration: number;
  /** Phase 7B.1b: the daemon offers protocol v2 read-only desktop calls. Absent: v1 only. */
  desktop?: DesktopOffer;
}

export interface DesktopOffer { proto: 2; tools: string[] }

/** Phase 7B.1b: the daemon's answer to a host-originated v2 call. */
export interface DesktopReply {
  v: 2;
  kind: "reply";
  callId: string;
  status: "ok" | "error" | "cancelled";
  result?: unknown;
  error?: { code: string; message: string; candidates?: unknown };
}

export const CALL_ID = /^c[0-9]{1,9}$/;
const DESKTOP_TOOL = /^desktop\.[a-z_]{1,40}$/;
/** Browser stage 2: the daemon's approval authority for browser actions is offered on the same v2 channel (exact name). */
const OTHER_OFFERED_TOOLS: ReadonlySet<string> = new Set(["browser.request_action", "files.organize", "files.undo_organize", "files.copy", "files.rename", "files.undo_copy_rename", "notes.create",
  "workflows.save", "workflows.list", "workflows.get", "workflows.delete", "workflows.schedule", "workflows.unschedule",
  "plugins.list", "plugins.approve", "plugins.revoke", "plugins.grant", "plugins.revoke_permission", "plugins.disable", "plugins.enable", "dev.run_task", "dev.edit_file",
  // Windows administration and the user's Chrome (2026-11-14): exact names only.
  "system.list_processes", "system.process_info", "system.end_process", "system.list_services", "system.service_info", "system.service_control",
  "system.network_status", "system.set_radio", "system.audio_status", "system.set_volume", "system.display_status", "system.set_brightness",
  "system.startup_apps", "system.startup_toggle", "system.power", "system.cancel_power",
  "chrome.status", "chrome.authorize", "chrome.revoke", "chrome.open", "chrome.list_tabs", "chrome.open_tab", "chrome.navigate", "chrome.switch_tab",
  "chrome.close_tab", "chrome.read_page", "chrome.click", "chrome.fill", "chrome.search"]);
// desktop.read_text matches DESKTOP_TOOL (desktop.*) already.
// The full product profile offers every capability at once (about 35 names after copy/rename were added; found when the host refused to start in
// the real HUD with everything enabled). Names stay exact (allowlist above); only the count bound grows.
const MAX_OFFERED_TOOLS = 128;   // 2026-11-14: + 7 input/clipboard, 16 system, ~12 chrome, dev.edit_file

/** Validates the optional `desktop` offer in hello. Strict: unknown fields, other protocols or odd names are refused. */
function parseDesktopOffer(v: unknown, id: string): DesktopOffer {
  if (!isPlainObject(v)) throw new ProtocolError("invalid_params", "desktop must be an object", id);
  for (const k of Object.keys(v)) if (k !== "proto" && k !== "tools") throw new ProtocolError("invalid_params", `Unknown desktop field "${k.slice(0, 40)}"`, id);
  if (v.proto !== 2) throw new ProtocolError("invalid_params", "desktop.proto must be 2", id);
  if (!Array.isArray(v.tools) || v.tools.length > MAX_OFFERED_TOOLS ||
      !v.tools.every((t) => typeof t === "string" && (DESKTOP_TOOL.test(t) || OTHER_OFFERED_TOOLS.has(t)))) {
    throw new ProtocolError("invalid_params", `desktop.tools must be up to ${MAX_OFFERED_TOOLS} desktop.* names (or browser.request_action)`, id);
  }
  return { proto: 2, tools: v.tools as string[] };
}

/** Strictly parses a daemon reply line. Returns null when the line is not a reply at all. */
export function parseReply(raw: unknown): DesktopReply | null {
  if (!isPlainObject(raw) || raw.kind !== "reply") return null;
  for (const k of Object.keys(raw)) {
    if (!["v", "kind", "callId", "status", "result", "error"].includes(k)) throw new ProtocolError("invalid_request", `Unknown reply field "${k.slice(0, 40)}"`);
  }
  if (raw.v !== 2) throw new ProtocolError("unsupported_version", "A reply must be protocol v2");
  if (typeof raw.callId !== "string" || !CALL_ID.test(raw.callId)) throw new ProtocolError("invalid_request", "reply callId is invalid");
  if (raw.status !== "ok" && raw.status !== "error" && raw.status !== "cancelled") throw new ProtocolError("invalid_request", "reply status is invalid");
  if (raw.error !== undefined) {
    const e = raw.error;
    if (!isPlainObject(e) || typeof e.code !== "string" || typeof e.message !== "string") throw new ProtocolError("invalid_request", "reply error is invalid");
  }
  return raw as unknown as DesktopReply;
}
export interface SubmitParams { taskId: string; objective: string }
export interface TaskRefParams { taskId: string }
export interface GenerationParams { generation: number }

export type Request =
  | { v: 1; id: string; op: "hello"; params: HelloParams }
  | { v: 1; id: string; op: "health"; params: Record<string, never> }
  | { v: 1; id: string; op: "submit"; params: SubmitParams }
  | { v: 1; id: string; op: "status"; params: TaskRefParams }
  | { v: 1; id: string; op: "cancel"; params: TaskRefParams }
  | { v: 1; id: string; op: "emergency_stop"; params: GenerationParams }
  | { v: 1; id: string; op: "resume"; params: GenerationParams }
  | { v: 1; id: string; op: "shutdown"; params: Record<string, never> };

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly requestId: string | null = null) {
    super(message);
    this.name = "ProtocolError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

type Spec = Record<string, "string" | "boolean" | "generation">;
const PARAMS: Record<Op, Spec> = {
  hello: { token: "string", emergencyStopped: "boolean", stopGeneration: "generation" },
  health: {},
  submit: { taskId: "string", objective: "string" },
  status: { taskId: "string" },
  cancel: { taskId: "string" },
  emergency_stop: { generation: "generation" },
  resume: { generation: "generation" },
  shutdown: {},
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and fully validate one input line. Throws ProtocolError with the best known request id. */
export function parseRequest(line: string): Request {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("malformed_json", "The line is not valid JSON");
  }
  if (!isPlainObject(raw)) throw new ProtocolError("invalid_request", "A request must be a JSON object");

  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  if (id === null) throw new ProtocolError("invalid_request", "id must match ^[A-Za-z0-9_-]{1,64}$");
  for (const k of Object.keys(raw)) {
    if (k !== "v" && k !== "id" && k !== "op" && k !== "params") throw new ProtocolError("invalid_request", `Unknown field "${k.slice(0, 40)}"`, id);
  }
  if (raw.v !== PROTOCOL_VERSION) throw new ProtocolError("unsupported_version", `Unsupported protocol version; this host speaks v${PROTOCOL_VERSION}`, id);
  if (typeof raw.op !== "string") throw new ProtocolError("invalid_request", "op must be a string", id);
  if (!Object.prototype.hasOwnProperty.call(PARAMS, raw.op)) throw new ProtocolError("unknown_op", `Unknown operation "${raw.op.slice(0, 40)}"`, id);

  const op = raw.op as Op;
  const rawParams: unknown = raw.params === undefined ? {} : raw.params;
  if (!isPlainObject(rawParams)) throw new ProtocolError("invalid_params", "params must be an object", id);
  let params: Record<string, unknown> = rawParams;
  // Phase 7B.1b: hello may carry an optional desktop offer; it is validated on its own, the rest stays strict.
  let desktop: DesktopOffer | undefined;
  if (op === "hello" && Object.prototype.hasOwnProperty.call(params, "desktop")) {
    desktop = parseDesktopOffer(params.desktop, id);
    const { desktop: _omit, ...rest } = params;
    params = rest;
  }
  const spec = PARAMS[op];
  for (const k of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new ProtocolError("invalid_params", `Unknown parameter "${k.slice(0, 40)}" for ${op}`, id);
  }
  for (const [k, type] of Object.entries(spec)) {
    const v = params[k];
    const ok = type === "string" ? typeof v === "string"
      : type === "boolean" ? typeof v === "boolean"
      : typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (!ok) throw new ProtocolError("invalid_params", `Parameter "${k}" must be ${type === "generation" ? "a non-negative integer" : `a ${type}`}`, id);
  }
  if (op === "submit") {
    const s = params as unknown as SubmitParams;
    if (!ID.test(s.taskId)) throw new ProtocolError("invalid_params", "taskId must match ^[A-Za-z0-9_-]{1,64}$", id);
    if (!s.objective.trim()) throw new ProtocolError("invalid_params", "objective must not be empty", id);
    if (s.objective.length > MAX_OBJECTIVE_CHARS) throw new ProtocolError("invalid_params", `objective is longer than ${MAX_OBJECTIVE_CHARS} characters`, id);
  }
  if ((op === "status" || op === "cancel") && !ID.test((params as unknown as TaskRefParams).taskId)) {
    throw new ProtocolError("invalid_params", "taskId must match ^[A-Za-z0-9_-]{1,64}$", id);
  }
  return { v: 1, id, op, params: desktop ? { ...params, desktop } : params } as Request;
}

export const encodeResult = (id: string, result: unknown): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, kind: "response", id, ok: true, result });

export const encodeError = (id: string | null, code: ErrorCode, message: string): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, kind: "response", id, ok: false, error: { code, message } });

export const encodeEvent = (event: "task.progress" | "task.finished", requestId: string, taskId: string, seq: number, data: unknown): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, kind: "event", event, requestId, taskId, seq, data });
