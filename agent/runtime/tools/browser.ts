// ─────────────────────────────────────────────────────────────────────────────
// Browser automation, stage 1: read a web page the USER named, in local Chromium (agent/runtime/browser). The model can
// never choose a site: the URL is pinned to what the request contains (argument domains), every request the page makes is
// checked against that site (policy.ts), and the result counts only if the page that loaded is that site.
// Acting in pages (clicking, filling forms, signing in, buying, downloading) is NOT available here: such requests are
// answered with a refusal before planning; they need the daemon's approval pathway (stage 2).
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import type { BrowserEngine, BrowserSessions, PageReading } from "../browser/playwrightEngine";
import { BrowserPolicyError } from "../browser/policy";
import { createBrowserActionTools, requestedBrowserActions } from "./browserActions";
import type { DesktopBridge } from "./desktop";
import { sameSite, urlsIn, namedSiteOf } from "../browser/policy";
import type { GroundingVerdict, ToolRequestCheck, ToolSpec, RequestFacet } from "../types";

export const MAX_PAGES_PER_REQUEST = 3;

const READ_INTENT = /\b(open|go\s+to|visit|browse|navigate\s+to|read|load|fetch|show|summari[sz]e|what(?:'s|\s+is|\s+does|\s+do)|tell\s+me|check|look\s+at|get|title\s+of|headlines?|links?)\b/i;
const PAGE_ACTION = /\b(click|tap|fill(?:\s+in)?|type|enter\s+(?:my|the|a)|submit|log\s?in|sign\s?(?:in|up)|register|buy|purchase|order|checkout|pay|book|download|upload|post|send|reply|comment|subscribe|delete|like|share|follow)\b/i;

/** The pages the request asks to read, or [] if it is not a read request. */
export function requestedPages(objective: string): string[] {
  const urls = urlsIn(objective);
  if (urls.length === 0 || urls.length > MAX_PAGES_PER_REQUEST) return [];
  if (PAGE_ACTION.test(objective.replace(/\bhttps?:\/\/\S+/gi, " "))) return [];
  // A named address with no page action is a request to read it ("what does example.com say", "example.com headlines").
  void READ_INTENT;
  return urls;
}

/** Refusals and questions before planning. */
export function browserClarification(objective: string, actionsOffered: () => boolean = () => false): string | null {
  const urls = urlsIn(objective);
  if (urls.length === 0) return null;
  // Stage 2: an approval-gated sequence of clicks and field fills on one named page is not refused here (when offered).
  if (actionsOffered() && requestedBrowserActions(objective)) return null;
  if (PAGE_ACTION.test(objective.replace(/\bhttps?:\/\/\S+/gi, " "))) {
    return actionsOffered()
      ? "I can click elements and fill text fields on a page you name, each with your approval in the HUD, phrased like: On example.com, type \"…\" into the Search field, then click the Go button. I never sign in for you, enter passwords or payment details, download or upload files."
      : "I can open and read a web page you name, but I can't click, fill in forms, sign in, buy, post or download on web pages yet.";
  }
  if (urls.length > MAX_PAGES_PER_REQUEST) return `Your request names ${urls.length} web addresses; I read at most ${MAX_PAGES_PER_REQUEST} per request. Please name fewer.`;
  return null;
}

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });

interface ReadInput { url: string }

/** The loaded page is the site the facet named, with a successful status and some text. */
function readingMatches(url: string, o: PageReading | undefined): boolean {
  if (!o) return false;
  let host: string;
  try { host = new URL(o.finalUrl).hostname; } catch { return false; }
  return sameSite(host, namedSiteOf(url)) && o.status >= 200 && o.status < 300 && o.textLength > 0;
}

export const readPageCheck: ToolRequestCheck<ReadInput, PageReading> = {
  argumentDomains(objective) {
    const pages = requestedPages(objective);
    return { url: pages.length ? { kind: "enum", values: pages, optional: false } : { kind: "forbidden", reason: "the request names no web page to read" } };
  },
  relevant: (o) => requestedPages(o).length > 0,
  clarify: browserClarification,
  facets(objective) {
    return requestedPages(objective).map((u) => ({ id: `browser:read:${u}`, tool: "browser.read_page", description: `read the web page ${u}`, data: { url: u } }) satisfies RequestFacet);
  },
  ground(input, objective) {
    const pages = requestedPages(objective);
    if (pages.length === 0) return ungrounded("the request names no web page to read");
    if (!pages.includes(input.url)) return contradicted(`the request names ${pages.join(", ")}`);
    return grounded("the address is taken from the request");
  },
  satisfies(facet, input, outcome) {
    const url = (facet.data as { url: string }).url;
    return outcome.ok && input.url === url && readingMatches(url, outcome.output);
  },
  vocabulary: (objective) => ["open", "go", "to", "visit", "browse", "navigate", "read", "load", "fetch", "show", "summarize", "summarise",
    "what", "is", "does", "do", "say", "says", "tell", "me", "check", "look", "at", "get", "the", "page", "web", "website", "site", "webpage",
    "title", "of", "headline", "headlines", "link", "links", "on", "about", "content", "contents", "text", "and", "please", "this", "that", "url",
    ...requestedPages(objective).flatMap((u) => contentWords(u.replace(/[/:.?=&#_-]+/g, " "))), ...contentWords(objective.match(/\bhttps?:\/\/\S+|\b[\w.-]+\.[a-z]{2,}\S*/gi)?.join(" ").replace(/[/:.?=&#_-]+/g, " ") ?? "")],
};

export function createReadPageTool(engine: BrowserEngine, actionsOffered: () => boolean = () => false): ToolSpec<ReadInput, PageReading> {
  return {
    name: "browser.read_page",
    description: "Open ONE web page the user named (exact address from the request) in a private local browser and read its title, text and links. Read-only: it never clicks, fills, signs in or downloads.",
    inputSchema: { type: "object", properties: { url: { type: "string", minLength: 4, maxLength: 2000 } }, required: ["url"] },
    permissions: ["network"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 45_000,
    async execute(input, ctx) {
      if (!engine.available) return { ok: false, error: "Web browsing is not available.", evidence: "" };
      try {
        const r = await engine.read(input.url, ctx.signal);
        const blocked = r.blocked.length ? ` ${r.blocked.length} request(s) to other sites or of disallowed kinds were blocked.` : "";
        if (r.status < 200 || r.status >= 300) return { ok: false, output: r, error: `The page answered with HTTP ${r.status}.`, evidence: "" };
        const links = r.links.slice(0, 15).map((l) => `• ${l.text} → ${l.href}`);
        return {
          ok: true, output: r,
          evidence: [`Read "${r.title || "(untitled)"}" at ${r.finalUrl} (HTTP ${r.status}, ${r.textLength} characters${r.truncated ? ", excerpt" : ""}).${blocked}`,
            r.text.slice(0, 1200), ...(links.length ? ["Links:", ...links] : [])].join("\n"),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: e instanceof BrowserPolicyError ? `Not opened: ${msg}.` : `The page could not be read: ${msg.split("\n")[0]}`, evidence: "" };
      }
    },
    check(input, outcome) {
      return readingMatches(input.url, outcome.output) ? { ok: true } : { ok: false, reason: "the page that loaded is not the named site, or it had no content" };
    },
    requestCheck: { ...readPageCheck, clarify: (o) => browserClarification(o, actionsOffered) },
  };
}

/** Stage 1 always (when browsing is enabled); stage 2 only with task sessions AND the daemon's approval tool. */
export function createBrowserTools(engine: BrowserEngine, actions?: { sessions: BrowserSessions; bridge: DesktopBridge }): ToolSpec<any, any>[] {
  if (!actions) return [createReadPageTool(engine)];
  const offered = () => actions.bridge.available && (actions.bridge.offers ? actions.bridge.offers("browser.request_action") : true);
  return [createReadPageTool(engine, offered), ...createBrowserActionTools(actions.sessions, actions.bridge)];
}
