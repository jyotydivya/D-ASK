/**
 * Windows administration through natural language (2026-11-14). A deterministic grammar maps a request to ONE daemon `system.*` call with
 * exactly the arguments the request states (the model never chooses a process, service, radio, level or power action). Reads need no
 * approval; every change is approved in the HUD by the daemon, performed once and verified by reading the real state back. Power actions
 * are always scheduled (default 60 s) and can be cancelled ("cancel the restart") or stopped by Emergency Stop.
 */
import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, ToolSpec } from "../types";
import type { DesktopBridge, DesktopReply } from "./desktop";

export type SystemTool =
  | "system.list_processes" | "system.process_info" | "system.end_process"
  | "system.list_services" | "system.service_info" | "system.service_control"
  | "system.network_status" | "system.set_radio" | "system.audio_status" | "system.set_volume"
  | "system.display_status" | "system.set_brightness" | "system.startup_apps" | "system.startup_toggle"
  | "system.power" | "system.cancel_power";

export interface SystemRequest { tool: SystemTool; args: Record<string, string | number | boolean | undefined> }

const P = String.raw`^\s*(?:please\s+|can you\s+|could you\s+|hey d-ask,?\s+)?`;
const END = String.raw`\s*[.!?]?\s*$`;
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()] ?? NaN);
const NAME = String.raw`["“]?([A-Za-z0-9][A-Za-z0-9 ._+\-]{0,60}?)["”]?`;

const R = (s: string) => new RegExp(P + "(?:" + s + ")" + END, "i");   // the anchors apply to every alternative
const RULES: [RegExp, (m: RegExpExecArray) => SystemRequest | null][] = [
  // ── power (scheduled; cancel first so "cancel the restart" is never read as a restart) ──
  [R(String.raw`(?:cancel|abort|stop)\s+(?:the\s+|my\s+|that\s+)?(?:scheduled\s+|pending\s+)?(?:restart|reboot|shut\s*down|shutdown|sign[- ]?out|log\s*off|sleep|power\s+action)`),
    () => ({ tool: "system.cancel_power", args: {} })],
  [R(String.raw`(restart|reboot|shut\s*down|power\s+off|turn\s+off|sign\s*out(?:\s+of\s+windows)?|log\s*(?:off|out)|put)\s*(?:the\s+|my\s+|this\s+)?(?:computer|pc|laptop|machine|system|windows|me)?\s*(?:to\s+sleep)?(?:\s+in\s+(\d{1,4}|one|two|three|four|five|ten|fifteen|twenty|thirty)\s+(seconds?|secs?|minutes?|mins?))?`),
    (m) => {
      const verb = m[1]!.toLowerCase().replace(/\s+/g, " ");
      const action = /restart|reboot/.test(verb) ? "restart" : /shut|power off|turn off/.test(verb) ? "shutdown" : /sign|log/.test(verb) ? "signout" : verb === "put" ? (/sleep/i.test(m[0]) ? "sleep" : null) : null;
      if (!action) return null;
      if ((verb === "turn off" || verb === "power off") && !/computer|pc|laptop|machine|system/i.test(m[0])) return null;   // "turn off wifi" is not a shutdown
      let delay = 60;
      if (m[2]) { const n = num(m[2]); if (!Number.isFinite(n)) return null; delay = /min/i.test(m[3]!) ? n * 60 : n; }
      return delay >= 30 && delay <= 3600 ? { tool: "system.power", args: { action, delaySeconds: delay } } : null;
    }],
  [R(String.raw`(?:go\s+to\s+sleep|sleep\s+(?:the\s+)?(?:computer|pc|laptop))(?:\s+in\s+(\d{1,4})\s+(seconds?|minutes?))?`),
    (m) => { const d = m[1] ? (/min/i.test(m[2]!) ? Number(m[1]) * 60 : Number(m[1])) : 60; return d >= 30 && d <= 3600 ? { tool: "system.power", args: { action: "sleep", delaySeconds: d } } : null; }],
  // ── radios ──
  [R(String.raw`(?:turn|switch)\s+(on|off)\s+(?:the\s+)?(wi-?fi|bluetooth)(?:\s+radio)?`), (m) => ({ tool: "system.set_radio", args: { radio: m[2]!.toLowerCase().replace("-", ""), state: m[1]!.toLowerCase() } })],
  [R(String.raw`(?:turn|switch)\s+(?:the\s+)?(wi-?fi|bluetooth)(?:\s+radio)?\s+(on|off)`), (m) => ({ tool: "system.set_radio", args: { radio: m[1]!.toLowerCase().replace("-", ""), state: m[2]!.toLowerCase() } })],
  [R(String.raw`(enable|disable)\s+(?:the\s+)?(wi-?fi|bluetooth)`), (m) => ({ tool: "system.set_radio", args: { radio: m[2]!.toLowerCase().replace("-", ""), state: m[1]!.toLowerCase() === "enable" ? "on" : "off" } })],
  // ── audio ──
  [R(String.raw`(?:set|change|turn)\s+(?:the\s+)?(?:volume|sound)\s+(?:level\s+)?to\s+(\d{1,3})\s*(?:%|percent)?`), (m) => { const n = Number(m[1]); return n <= 100 ? { tool: "system.set_volume", args: { percent: n } } : null; }],
  [R(String.raw`(mute|unmute)(?:\s+(?:the\s+)?(?:sound|volume|audio|speakers?|computer))?`), (m) => ({ tool: "system.set_volume", args: { mute: m[1]!.toLowerCase() === "mute" } })],
  [R(String.raw`(?:what(?:'s|\s+is)\s+the\s+(?:volume|sound\s+level)|(?:show|list|check)\s+(?:the\s+|my\s+)?(?:audio|sound)\s+(?:devices|settings|status)|audio\s+status|is\s+(?:the\s+sound|my\s+computer)\s+muted)`),
    () => ({ tool: "system.audio_status", args: {} })],
  // ── display ──
  [R(String.raw`(?:set|change|turn)\s+(?:the\s+|screen\s+|my\s+)?(?:screen\s+|display\s+)?brightness\s+(?:to\s+)?(\d{1,3})\s*(?:%|percent)?`), (m) => { const n = Number(m[1]); return n <= 100 ? { tool: "system.set_brightness", args: { percent: n } } : null; }],
  [R(String.raw`(?:what(?:'s|\s+is)\s+(?:the\s+|my\s+)?(?:screen\s+)?(?:resolution|brightness)|(?:show|check|list)\s+(?:the\s+|my\s+)?(?:display|screen|monitor)s?(?:\s+(?:settings|configuration|info|status))?|display\s+(?:settings|status))`),
    () => ({ tool: "system.display_status", args: {} })],
  // ── network ──
  [R(String.raw`(?:(?:show|check|what(?:'s|\s+is))\s+(?:the\s+|my\s+)?(?:network|wi-?fi|bluetooth|internet|connection)(?:\s+(?:status|connection|adapters?|state|settings))?|am\s+i\s+(?:connected|online)(?:\s+to\s+(?:wi-?fi|the\s+internet))?|(?:list|show)\s+(?:the\s+|my\s+)?network\s+adapters|is\s+(?:wi-?fi|bluetooth)\s+(?:on|off|enabled|connected))`),
    () => ({ tool: "system.network_status", args: {} })],
  // ── startup apps ──
  [R(String.raw`(enable|disable)\s+${NAME}\s+(?:at|on|from)\s+(?:windows\s+)?start-?up`), (m) => ({ tool: "system.startup_toggle", args: { name: m[2]!.trim(), enabled: m[1]!.toLowerCase() === "enable" } })],
  [R(String.raw`(enable|disable)\s+the\s+start-?up\s+(?:app|program|entry)\s+${NAME}`), (m) => ({ tool: "system.startup_toggle", args: { name: m[2]!.trim(), enabled: m[1]!.toLowerCase() === "enable" } })],
  [R(String.raw`(?:show|list|what\s+are)\s+(?:the\s+|my\s+)?start-?up\s+(?:apps|programs|applications|items|entries)`), () => ({ tool: "system.startup_apps", args: {} })],
  // ── services ──
  [R(String.raw`(start|stop)\s+the\s+${NAME}\s+service`), (m) => ({ tool: "system.service_control", args: { name: m[2]!.trim(), action: m[1]!.toLowerCase() } })],
  [R(String.raw`(?:is\s+the\s+${NAME}\s+service\s+running|(?:show|check)\s+(?:the\s+)?(?:status\s+of\s+)?the\s+${NAME}\s+service(?:\s+status)?)`),
    (m) => ({ tool: "system.service_info", args: { name: (m[1] ?? m[2])!.trim() } })],
  [R(String.raw`(?:list|show)\s+(?:all\s+)?(?:the\s+)?(?:running\s+)?(?:windows\s+)?services(?:\s+(?:named|matching|containing)\s+${NAME})?`), (m) => ({ tool: "system.list_services", args: m[1] ? { filter: m[1].trim() } : {} })],
  // ── processes ──
  [R(String.raw`(?:end|kill|terminate|force\s+quit|stop)\s+(?:the\s+)?process\s+(\d{1,7})`), (m) => ({ tool: "system.end_process", args: { pid: Number(m[1]) } })],
  [R(String.raw`(?:end|kill|terminate|force\s+quit)\s+(?:the\s+)?(?:process\s+|program\s+)?${NAME}(?:\.exe)?(?:\s+process)?`), (m) => ({ tool: "system.end_process", args: { name: m[1]!.trim() } })],
  [R(String.raw`(?:show|get)\s+(?:details|info(?:rmation)?)\s+(?:about|for|on)\s+(?:the\s+)?process\s+(\d{1,7}|[A-Za-z0-9][A-Za-z0-9._+\-]{0,60}?)(?:\.exe)?`),
    (m) => (/^\d+$/.test(m[1]!) ? { tool: "system.process_info", args: { pid: Number(m[1]) } } : { tool: "system.process_info", args: { name: m[1]!.trim() } })],
  [R(String.raw`(?:list|show)\s+(?:all\s+)?(?:the\s+|my\s+)?(?:running\s+)?processes(?:\s+(?:named|matching|containing|for)\s+${NAME})?|what\s+processes\s+are\s+running`), (m) => ({ tool: "system.list_processes", args: m[1] ? { filter: m[1].trim() } : {} })],
];

/** Words that are never a process name in "kill X" (they belong to other requests). */
const NOT_A_PROCESS = /^(?:the\s+)?(?:wi-?fi|bluetooth|sound|volume|computer|pc|it|that|this|task|request|music)$/i;

/** The single administration request this objective is, or null. */
export function systemRequest(o: string): SystemRequest | null {
  if (o.length > 300 || /\b(?:and|then)\b\s+(?:then\s+)?(?:open|type|click|turn|set|start|stop|restart|kill|end|mute|enable|disable)\b/i.test(o)) return null;   // one request at a time
  for (const [re, f] of RULES) {
    const m = re.exec(o);
    if (!m) continue;
    const r = f(m);
    if (r && r.tool === "system.end_process" && typeof r.args.name === "string" && NOT_A_PROCESS.test(r.args.name)) return null;
    return r;
  }
  return null;
}

async function call(bridge: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, ms: number) {
  if (!bridge.available) return { reply: null as DesktopReply | null, error: "Windows administration is not available (the daemon did not enable it)." };
  try { return { reply: await bridge.call(ctx.taskId, tool, args, ctx.signal, ms), error: null }; }
  catch (e) { return { reply: null, error: e instanceof Error ? e.message : String(e) }; }
}

const lines = (xs: string[], max = 25) => xs.slice(0, max).map((x) => `• ${x}`).join("\n") + (xs.length > max ? `\n… and ${xs.length - max} more` : "");

/** What the user is told, from the daemon's verified result only. */
function evidenceFor(tool: SystemTool, r: any): string {
  switch (tool) {
    case "system.list_processes": return `${r.observed}:\n${lines((r.processes ?? []).map((p: any) => `${p.name} (pid ${p.pid}, ${p.memoryMb} MB${p.window ? `, "${p.window}"` : ""})`))}`;
    case "system.process_info": return (r.processes ?? []).map((p: any) => `${p.name} — pid ${p.pid}, ${p.memoryMb} MB, started ${p.started ?? "unknown"}, ${p.path ?? "path not readable"}${p.responding === false ? ", NOT RESPONDING" : ""}`).join("\n");
    case "system.list_services": return `${r.observed} (${r.running} running):\n${lines((r.services ?? []).map((s: any) => `${s.display} [${s.name}] — ${s.status}, ${s.start}`))}`;
    case "system.service_info": { const s = r.service ?? {}; return `${s.display} [${s.name}] is ${s.status} (start: ${s.start}; account ${s.account}).${r.controllable ? " D-ASK may start/stop it with your approval." : ""}`; }
    case "system.network_status": {
      const up = (r.adapters ?? []).filter((a: any) => a.status === "Up").map((a: any) => `${a.name} (${a.type}, ${a.speedMbps} Mbps, ${(a.ipv4 ?? []).join(", ")})`);
      const radios = Array.isArray(r.radios) ? r.radios.map((x: any) => `${x.name}: ${x.state}`).join("; ") : "radio states unavailable";
      const wifi = r.wifi?.state ? `Wi-Fi: ${r.wifi.state}${r.wifi.ssid ? ` to "${r.wifi.ssid}" (signal ${r.wifi.signal})` : ""}` : "Wi-Fi: no connection information";
      return `${wifi}\nRadios: ${radios}\nConnected adapters:\n${up.length ? lines(up) : "• none"}`;
    }
    case "system.audio_status": return r.hasOutput ? `Volume ${r.volumePercent}%${r.muted ? " (muted)" : ""}.${Array.isArray(r.devices) ? `\nAudio devices:\n${lines(r.devices.map((d: any) => `${d.name} (${d.status})`))}` : ""}` : "There is no default audio output device.";
    case "system.display_status": return `${(r.displays ?? []).map((d: any) => `${d.monitor || d.device}: ${d.width}×${d.height} @ ${d.refreshHz} Hz${d.primary ? " (primary)" : ""}`).join("\n")}\nBrightness: ${r.brightnessSupported ? `${r.brightnessPercent}%` : "not adjustable by apps on this display"}`;
    case "system.startup_apps": return `${r.observed}:\n${lines((r.apps ?? []).map((a: any) => `${a.name} — ${a.enabled ? "enabled" : "disabled"} (${a.source})`))}`;
    default: return `${r.observed ?? "Done"}.`;
  }
}

const SPECS: { tool: SystemTool; description: string; change: boolean }[] = [
  { tool: "system.list_processes", description: "List running processes (largest memory first), optionally filtered by name.", change: false },
  { tool: "system.process_info", description: "Details of one running process (by pid or name).", change: false },
  { tool: "system.end_process", description: "End ONE running program the request names (by pid, or by a name matching exactly one process). Approved in the HUD; verified gone. Windows/security/D-ASK processes are refused.", change: true },
  { tool: "system.list_services", description: "List Windows services and their status.", change: false },
  { tool: "system.service_info", description: "Status and configuration of one Windows service.", change: false },
  { tool: "system.service_control", description: "Start or stop ONE allowed Windows service. Approved in the HUD; status read back; administrator-only services are refused by Windows (UAC is respected).", change: true },
  { tool: "system.network_status", description: "Network adapters, the Wi-Fi connection and the Wi-Fi/Bluetooth radio states.", change: false },
  { tool: "system.set_radio", description: "Turn Wi-Fi or Bluetooth on or off. Approved in the HUD; state read back.", change: true },
  { tool: "system.audio_status", description: "Volume, mute state and audio devices.", change: false },
  { tool: "system.set_volume", description: "Set the volume (percent) or mute/unmute. Approved in the HUD; read back.", change: true },
  { tool: "system.display_status", description: "Displays (resolution, refresh rate) and brightness.", change: false },
  { tool: "system.set_brightness", description: "Set the screen brightness (percent). Approved in the HUD; read back.", change: true },
  { tool: "system.startup_apps", description: "Apps that start with Windows and whether each is enabled.", change: false },
  { tool: "system.startup_toggle", description: "Enable or disable ONE current-user startup app (the Task Manager switch). Approved in the HUD; read back.", change: true },
  { tool: "system.power", description: "Schedule sleep, restart, shutdown or sign-out (at least 30 s ahead, default 60 s). Approved in the HUD; cancellable; Emergency Stop cancels it.", change: true },
  { tool: "system.cancel_power", description: "Cancel a scheduled restart, shutdown, sleep or sign-out.", change: false },
];

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const same = (a: unknown, b: unknown) => JSON.stringify(a, Object.keys(a as object).sort()) === JSON.stringify(b, Object.keys(b as object).sort());

function createSystemTool(bridge: DesktopBridge, spec: (typeof SPECS)[number]): ToolSpec<Record<string, unknown>, any> {
  const offered = () => (bridge.offers ? bridge.offers(spec.tool === "system.end_process" ? "system.end_process" : spec.tool) : true);
  const req = (o: string) => { if (!offered()) return null; const r = systemRequest(o); return r && r.tool === spec.tool ? r : null; };
  const mine = (o: string) => req(o) !== null;
  const props: Record<string, any> = {
    filter: { type: "string", maxLength: 60 }, pid: { type: "integer", minimum: 1 }, name: { type: "string", maxLength: 80 }, action: { type: "string", maxLength: 20 },
    radio: { type: "string", enum: ["wifi", "bluetooth"] }, state: { type: "string", enum: ["on", "off"] }, percent: { type: "integer", minimum: 0, maximum: 100 },
    mute: { type: "boolean" }, enabled: { type: "boolean" }, delaySeconds: { type: "integer", minimum: 30, maximum: 3600 },
  };
  return {
    name: spec.tool,
    description: spec.description,
    inputSchema: { type: "object", properties: props },
    permissions: spec.change ? ["request:desktop_action"] : ["read:desktop"],
    risk: spec.change ? "medium" : "low",
    requiresApproval: false,
    timeoutMs: 120_000,
    async execute(input, ctx) {
      let args: Record<string, unknown> = { ...input };
      // "End notepad": resolve the name to exactly one process first (read-only), so the approval card names one exact pid.
      if (spec.tool === "system.end_process" && typeof input.name === "string") {
        const look = await call(bridge, "system.process_info", { name: input.name }, ctx, 20_000);
        if (!look.reply || look.reply.status !== "ok") return { ok: false, error: look.reply?.error?.message ?? look.error ?? `No process named ${input.name} is running.`, evidence: "" };
        const procs = (look.reply.result as any)?.processes ?? [];
        if (procs.length !== 1) return { ok: false, error: `${procs.length} processes are named ${input.name}; say which one by its pid (${procs.map((p: any) => p.pid).join(", ")}). Nothing was ended.`, evidence: "" };
        args = { pid: procs[0].pid };
      }
      const { reply, error } = await call(bridge, spec.tool, args, ctx, 115_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status === "cancelled") return { ok: false, error: "The request was cancelled. Nothing was done.", evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was done.", evidence: "" };
      const r = (reply.result ?? {}) as any;
      if (r.verified !== true) return { ok: false, output: r, error: `${r.observed ?? "The result could not be confirmed"}.`, evidence: "" };
      return { ok: true, output: r, evidence: evidenceFor(spec.tool, r) };
    },
    check: (_i, outcome) => (outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the result was not confirmed by reading Windows' state back" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        const d: Record<string, ArgumentDomain> = {};
        if (!r) return { name: { kind: "forbidden", reason: "the request does not ask for this" } };
        for (const [k, v] of Object.entries(r.args)) if (typeof v === "string") d[k] = { kind: "enum", values: [v], optional: false };
        return d;
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: `${spec.tool}:${JSON.stringify(req(o)!.args)}`, tool: spec.tool, description: spec.description.split(".")[0]!.toLowerCase(), data: req(o)!.args }] : []),
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask for this");
        return same(input, r.args) ? grounded("exactly what the request asks") : contradicted(`use exactly ${JSON.stringify(r.args)}`);
      },
      satisfies: (_f, _i, outcome) => outcome.ok && outcome.output?.verified === true,
      stepFor: (f, o) => (f.tool === spec.tool && req(o) ? { ...req(o)!.args } : null),
      vocabulary: (o) => [...contentWords(o)],
    },
  };
}

export const createSystemAdminTools = (bridge: DesktopBridge): ToolSpec<any, any>[] => SPECS.map((s) => createSystemTool(bridge, s));
export const SYSTEM_TOOLS: readonly SystemTool[] = SPECS.map((s) => s.tool);
