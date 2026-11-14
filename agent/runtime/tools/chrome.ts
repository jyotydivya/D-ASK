/**
 * The user's own Google Chrome (2026-11-14), through the D-ASK extension and Chrome Native Messaging (no debugging port). A deterministic
 * grammar maps requests that NAME CHROME ("… in Chrome", "my Chrome tabs") to ONE daemon chrome.* call with exactly the request's URL,
 * text, field or tab title. The daemon asks once to authorize the session, asks separately for every consequential click, verifies each
 * result from what Chrome reports, and revokes access on Emergency Stop. D-ASK's private browser tools are unchanged and separate.
 */
import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, ToolSpec } from "../types";
import type { DesktopBridge, DesktopReply } from "./desktop";

export type ChromeTool = "chrome.status" | "chrome.authorize" | "chrome.revoke" | "chrome.open" | "chrome.list_tabs" | "chrome.open_tab" | "chrome.navigate"
  | "chrome.switch_tab" | "chrome.read_page" | "chrome.click" | "chrome.fill" | "chrome.search";
export interface ChromeRequest { tool: ChromeTool; args: Record<string, string | number | undefined> }

const P = String.raw`^\s*(?:please\s+|can you\s+|could you\s+)?`;
const END = String.raw`\s*[.!?]?\s*$`;
const IN_CHROME = String.raw`\s+(?:in|on|using|with)\s+(?:my\s+|google\s+)?chrome`;
const URL_RE = String.raw`((?:https?:\/\/)?(?:localhost|127\.0\.0\.1|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{2,5})?(?:\/[^\s"”]*)?)`;
const Q = String.raw`["“]([^"”]{1,200})["”]`;
const R = (s: string) => new RegExp(P + "(?:" + s + ")" + END, "i");

const RULES: [RegExp, (m: RegExpExecArray) => ChromeRequest | null][] = [
  [R(String.raw`(?:stop\s+controlling|revoke\s+(?:d-ask'?s?\s+)?(?:access\s+to|control\s+of))\s+(?:my\s+)?chrome`), () => ({ tool: "chrome.revoke", args: {} })],
  [R(String.raw`(?:let\s+d-ask\s+control|authori[sz]e\s+(?:d-ask\s+(?:to\s+control\s+)?)?)\s*(?:my\s+)?chrome`), () => ({ tool: "chrome.authorize", args: {} })],
  [R(String.raw`(?:is\s+(?:my\s+)?chrome\s+connected|chrome\s+(?:connection\s+)?status)`), () => ({ tool: "chrome.status", args: {} })],
  [R(String.raw`(?:list|show)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:open\s+)?chrome\s+tabs|what\s+tabs\s+are\s+open` + String.raw`(?:${IN_CHROME})?`), () => ({ tool: "chrome.list_tabs", args: {} })],
  [R(String.raw`(?:search|google)\s+(?:google\s+)?(?:for\s+)?${Q}${IN_CHROME}|search\s+(?:for\s+)?(.{1,120}?)${IN_CHROME}`), (m) => ({ tool: "chrome.search", args: { query: (m[1] ?? m[2])!.trim() } })],
  [R(String.raw`open\s+(?:a\s+)?new\s+(?:chrome\s+)?tab\s+(?:with|for|at|to)\s+${URL_RE}(?:${IN_CHROME})?|open\s+${URL_RE}\s+in\s+a\s+new\s+(?:chrome\s+)?tab`), (m) => ({ tool: "chrome.open_tab", args: { url: (m[1] ?? m[2])! } })],
  [R(String.raw`(?:open|go\s+to|navigate\s+to|visit|load)\s+${URL_RE}${IN_CHROME}`), (m) => ({ tool: "chrome.open", args: { url: m[1]! } })],
  [R(String.raw`switch\s+to\s+(?:the\s+)?${Q}\s+tab(?:${IN_CHROME})?|switch\s+to\s+(?:the\s+)?(.{1,60}?)\s+tab${IN_CHROME}`), (m) => ({ tool: "chrome.switch_tab", args: { title: (m[1] ?? m[2])!.trim() } })],
  [R(String.raw`(?:read|summari[sz]e|what(?:'s|\s+is)\s+on)\s+(?:the\s+|this\s+)?(?:current\s+|open\s+)?(?:web\s*)?page${IN_CHROME}`), () => ({ tool: "chrome.read_page", args: {} })],
  [R(String.raw`click\s+(?:on\s+)?(?:the\s+)?(?:link\s+|button\s+)?${Q}(?:\s+(?:link|button))?${IN_CHROME}`), (m) => ({ tool: "chrome.click", args: { text: m[1]! } })],
  [R(String.raw`(?:fill\s+(?:in\s+)?|type\s+|enter\s+)${Q}\s+(?:into|in)\s+(?:the\s+)?${Q}\s+(?:field|box)${IN_CHROME}`), (m) => ({ tool: "chrome.fill", args: { text: m[1]!, field: m[2]! } })],
  [R(String.raw`fill\s+(?:in\s+)?(?:the\s+)?${Q}\s+(?:field|box)\s+with\s+${Q}${IN_CHROME}`), (m) => ({ tool: "chrome.fill", args: { field: m[1]!, text: m[2]! } })],
];

export function chromeRequest(o: string): ChromeRequest | null {
  if (o.length > 400 || !/chrome|tabs?\b/i.test(o)) return null;
  for (const [re, f] of RULES) { const m = re.exec(o); if (m) return f(m); }
  return null;
}

async function call(bridge: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, ms: number) {
  if (!bridge.available) return { reply: null as DesktopReply | null, error: "Chrome control is not available (the daemon did not enable it)." };
  try { return { reply: await bridge.call(ctx.taskId, tool, args, ctx.signal, ms), error: null }; }
  catch (e) { return { reply: null, error: e instanceof Error ? e.message : String(e) }; }
}

function evidenceFor(tool: ChromeTool, r: any): string {
  switch (tool) {
    case "chrome.list_tabs": return `${r.count} Chrome tab(s):\n${(r.tabs ?? []).map((t: any) => `• ${t.active ? "[active] " : ""}${t.title} — ${t.url}`).join("\n")}`;
    case "chrome.read_page": {
      const p = r.page ?? {};
      const links = (p.links ?? []).slice(0, 15).map((l: any) => `• ${l.text || l.href} → ${l.href}`).join("\n");
      return `Page "${p.title}" (${p.url}), read from your Chrome:\n${String(p.text ?? "").slice(0, 3000)}${p.truncated ? "\n[…page text truncated]" : ""}${links ? `\nLinks:\n${links}` : ""}`;
    }
    default: return `${r.observed ?? "Done"}.`;
  }
}

const SPECS: { tool: ChromeTool; description: string }[] = [
  { tool: "chrome.status", description: "Whether your Chrome is connected to D-ASK and authorized." },
  { tool: "chrome.authorize", description: "Ask you (HUD) to let D-ASK control your Chrome, including signed-in sites, until revoked or Emergency Stop." },
  { tool: "chrome.revoke", description: "Stop D-ASK controlling your Chrome now." },
  { tool: "chrome.open", description: "Open your Chrome (if needed) at the web address the request names; verified by the address Chrome reports." },
  { tool: "chrome.list_tabs", description: "List the tabs open in your Chrome." },
  { tool: "chrome.open_tab", description: "Open the named web address in a new tab of your Chrome." },
  { tool: "chrome.navigate", description: "Load the named web address in the current Chrome tab." },
  { tool: "chrome.switch_tab", description: "Switch to the Chrome tab whose title the request names." },
  { tool: "chrome.read_page", description: "Read the visible text, links and fields of the current Chrome page." },
  { tool: "chrome.click", description: "Click the link or button with exactly the quoted text in your Chrome; consequential clicks (buy, pay, send, delete, submit…) need their own approval." },
  { tool: "chrome.fill", description: "Fill the named field with exactly the quoted text (read back; never passwords or card numbers; nothing is submitted)." },
  { tool: "chrome.search", description: "Search the web in your Chrome (only when web search is enabled and the computer is online)." },
];

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const norm = (x: Record<string, unknown>) => JSON.stringify(Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => [k, x[k]]));

function createChromeTool(bridge: DesktopBridge, spec: (typeof SPECS)[number]): ToolSpec<Record<string, unknown>, any> {
  const req = (o: string) => { if (bridge.offers && !bridge.offers(spec.tool)) return null; const r = chromeRequest(o); return r && r.tool === spec.tool ? r : null; };
  const mine = (o: string) => req(o) !== null;
  return {
    name: spec.tool,
    description: spec.description,
    inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 2000 }, query: { type: "string", maxLength: 300 }, title: { type: "string", maxLength: 200 },
      text: { type: "string", maxLength: 2000 }, field: { type: "string", maxLength: 200 }, tabId: { type: "integer" } } },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 150_000,
    async execute(input, ctx) {
      const { reply, error } = await call(bridge, spec.tool, input, ctx, 145_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status === "cancelled") return { ok: false, error: "The request was cancelled. Nothing was done.", evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was done.", evidence: "" };
      const r = (reply.result ?? {}) as any;
      if (r.verified !== true) return { ok: false, output: r, error: `${r.observed ?? "Not confirmed"}.`, evidence: "" };
      return { ok: true, output: r, evidence: evidenceFor(spec.tool, r) };
    },
    check: (_i, outcome) => (outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "Chrome did not confirm the result" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        if (!r) return { url: { kind: "forbidden", reason: "the request does not ask for this" } };
        const d: Record<string, ArgumentDomain> = {};
        for (const [k, v] of Object.entries(r.args)) if (typeof v === "string") d[k] = { kind: "enum", values: [v], optional: false };
        return d;
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: `${spec.tool}:${norm(req(o)!.args)}`, tool: spec.tool, description: spec.description.split(";")[0]!.split(".")[0]!.toLowerCase(), data: req(o)!.args }] : []),
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask for this");
        return norm(input) === norm(r.args) ? grounded("exactly what the request asks") : contradicted(`use exactly ${JSON.stringify(r.args)}`);
      },
      satisfies: (_f, _i, outcome) => outcome.ok && outcome.output?.verified === true,
      stepFor: (f, o) => (f.tool === spec.tool && req(o) ? { ...req(o)!.args } : null),
      vocabulary: (o) => [...contentWords(o)],
    },
  };
}

export const createChromeTools = (bridge: DesktopBridge): ToolSpec<any, any>[] => SPECS.map((s) => createChromeTool(bridge, s));
