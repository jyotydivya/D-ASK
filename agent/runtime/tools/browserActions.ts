// ─────────────────────────────────────────────────────────────────────────────
// Browser stage 2: approved actions in D-ASK's private browser. The model never acts: it may only plan steps whose
// arguments are pinned to the user's request (element kind, element name, exact text); this code then, for each step,
//   1. opens the request's start page in the task's guarded browser (network locked to that site),
//   2. identifies exactly ONE visible, enabled element of that kind and name (never a password/payment-secret field),
//   3. asks the DAEMON for the user's approval of that exact action (site, page, element fingerprint, exact text),
//   4. checks the approval is for exactly that element and page, re-identifies the element (same fingerprint),
//   5. performs it once and verifies its effect independently (field value / page change / navigation).
// Steps run strictly in order; a step not performed and verified ends the sequence (nothing retried or skipped ahead).
// Off unless the daemon offers browser.request_action (AgentHost:BrowserActions) and browsing is enabled.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { contentWords } from "../grounding";
import type { BrowserSessions, ElementKind } from "../browser/playwrightEngine";
import { BrowserPolicyError, urlsIn } from "../browser/policy";
import type { DesktopBridge } from "./desktop";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolRequestCheck, ToolSpec } from "../types";

export const MAX_BROWSER_STEPS = 6;
export const DAEMON_TOOL = "browser.request_action";

export interface BrowserActionStep {
  tool: "browser.click_element" | "browser.fill_field";
  kind: ElementKind;
  name: string;
  text: string | null;
}
export interface BrowserActionRequest { startUrl: string; steps: BrowserActionStep[] }

const Q = `["“'‘]`, QE = `["”'’]`;
/** An element name: anything when quoted; unquoted it cannot contain " and " / " then " / commas (it would swallow a step). */
const NAME = `(?:${Q}(?<qn>[^"”'’]{1,80})${QE}|(?<un>(?:(?!\\s(?:and|then)\\s)[^,;"”'’]){1,80}?))`;
const FIELD_NOUN = "(?:field|box|text\\s*box|input|search\\s+box)";
const CLICK_NOUN = "(button|link|checkbox|check\\s+box|radio\\s+button|tab|menu\\s+item)";
const END = "\\s*[.!]?\\s*$";
const FILL_A = new RegExp(`^(?:type|enter|write)\\s+${Q}(?<text>[^"”'’]{1,500})${QE}\\s+(?:into|in)\\s+(?:the\\s+)?${NAME}\\s+${FIELD_NOUN}${END}`, "i");
const FILL_B = new RegExp(`^fill\\s+(?:in\\s+)?(?:the\\s+)?${NAME}\\s+${FIELD_NOUN}\\s+with\\s+${Q}(?<text>[^"”'’]{1,500})${QE}${END}`, "i");
const CLICK = new RegExp(`^click\\s+(?:on\\s+)?(?:the\\s+)?${NAME}\\s+(?<noun>${CLICK_NOUN.slice(1, -1)})${END}`, "i");
const START = /^\s*(?:please\s+)?(?:(?:on|at)\s+(?:the\s+(?:page|site)\s+)?|(?:open|go\s+to|visit|navigate\s+to|load)\s+(?:the\s+(?:page|site)\s+)?)(\S+?)\s*(?:,\s*(?:and\s+)?(?:then\s+)?|\s+(?:and\s+)?then\s+|\s+and\s+)(?=\S)/i;
const STEP_SPLIT = /(?:\s*,\s*(?:and\s+)?(?:then\s+)?|\s*;\s*(?:then\s+)?|\s+(?:and\s+)?then\s+|\s+and\s+)(?=(?:click|type|enter|write|fill)\b)/gi;
const QUOTED = /["“'‘][^"”'’]{1,500}["”'’]/g;
/** Never through this tool: files, downloads, credentials, payment secrets. */
const FORBIDDEN = /\b(download|upload|attach|install|password|passcode|passphrase|credit\s*card|card\s*number|cvv|cvc|otp|one[- ]time\s+code|cookie|token)\b/i;
const KIND: Record<string, ElementKind> = { button: "button", link: "link", checkbox: "checkbox", "check box": "checkbox", "radio button": "radio", tab: "tab", "menu item": "menuitem" };
const mask = (s: string) => s.replace(QUOTED, (q) => "_".repeat(q.length));

function parseStep(seg: string): BrowserActionStep | null {
  const nameOf = (m: RegExpExecArray) => (m.groups!.qn ?? m.groups!.un ?? "").trim();
  let m = FILL_A.exec(seg) ?? FILL_B.exec(seg);
  if (m) return nameOf(m) ? { tool: "browser.fill_field", kind: "field", name: nameOf(m), text: m.groups!.text! } : null;
  m = CLICK.exec(seg);
  if (m) return nameOf(m) ? { tool: "browser.click_element", kind: KIND[m.groups!.noun!.toLowerCase().replace(/\s+/g, " ")]!, name: nameOf(m), text: null } : null;
  return null;
}

/**
 * The start page and the ordered steps, or null when the request is not ENTIRELY such a sequence (fail closed).
 *   On http://127.0.0.1:8080/form, type "me@example.com" into the Email field, then click the Subscribe button
 *   Go to example.com and click the About link
 */
export function requestedBrowserActions(objective: string): BrowserActionRequest | null {
  if (FORBIDDEN.test(mask(objective))) return null;
  const urls = urlsIn(objective);
  if (urls.length !== 1) return null;
  const start = START.exec(objective);
  if (!start) return null;
  const startUrls = urlsIn(start[1]!);
  if (startUrls.length !== 1 || startUrls[0] !== urls[0]) return null;
  const rest = objective.slice(start[0].length);
  const masked = mask(rest);
  const segments: string[] = [];
  let from = 0;
  for (const x of masked.matchAll(STEP_SPLIT)) { segments.push(rest.slice(from, x.index!)); from = x.index! + x[0].length; }
  segments.push(rest.slice(from));
  if (segments.length > MAX_BROWSER_STEPS) return null;
  const steps: BrowserActionStep[] = [];
  for (const seg of segments) {
    const s = parseStep(seg.trim());
    if (!s) return null;
    steps.push(s);
  }
  return { startUrl: urls[0]!, steps };
}

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });
const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => x !== null))];

interface ClickArgs { kind?: string; name?: string }
interface FillArgs { name?: string; text?: string }
type Args = ClickArgs & FillArgs;

function isStep(tool: string, input: Args, s: BrowserActionStep): boolean {
  return s.tool === tool && input.name === s.name && (tool === "browser.fill_field" ? input.text === s.text : input.kind === s.kind);
}
const describe = (s: BrowserActionStep) => s.tool === "browser.fill_field" ? `fill the ${s.name} field` : `click the ${s.name} ${s.kind === "menuitem" ? "menu item" : s.kind}`;

function actionCheck(tool: BrowserActionStep["tool"], offered: () => boolean): ToolRequestCheck<Args, any> {
  const req = (o: string) => (offered() ? requestedBrowserActions(o) : null);
  const own = (o: string) => req(o)?.steps.filter((s) => s.tool === tool) ?? [];
  const mine = (o: string) => own(o).length > 0;
  return {
    argumentDomains(objective) {
      const s = own(objective);
      const none: ArgumentDomain = { kind: "forbidden", reason: "the request names no such browser action" };
      const d: Record<string, ArgumentDomain> = { name: s.length ? { kind: "enum", values: uniq(s.map((x) => x.name)), optional: false } : none };
      if (tool === "browser.click_element") d.kind = s.length ? { kind: "enum", values: uniq(s.map((x) => x.kind)), optional: false } : none;
      else d.text = s.length ? { kind: "enum", values: uniq(s.map((x) => x.text)), optional: false } : none;
      return d;
    },
    relevant: mine,
    facets(objective) {
      const r = req(objective);
      if (!r) return [];
      const out: RequestFacet[] = [];
      r.steps.forEach((s, i) => {
        if (s.tool !== tool) return;
        const data = { ...s };
        out.push(r.steps.length === 1
          ? { id: `browser:action:${tool}:${r.startUrl}`, tool, description: `${describe(s)} on ${r.startUrl}`, data }
          : { id: `browser:action:${i + 1}of${r.steps.length}:${tool}:${r.startUrl}`, tool, description: `browser step ${i + 1} of ${r.steps.length}: ${describe(s)}`, data,
              sequence: { key: "browser-steps", index: i, of: r.steps.length } });
      });
      return out;
    },
    ground(input, objective) {
      const s = own(objective);
      if (s.length === 0) return ungrounded("the request does not ask for this browser action");
      if (s.some((x) => isStep(tool, input, x))) return grounded("element and text are taken from the request");
      return contradicted(`the request asks to ${s.map(describe).join(" / ")}`);
    },
    satisfies(facet, input, outcome) {
      const o = outcome.output;
      return outcome.ok && !!o && o.executed === true && o.verified === true && isStep(tool, input, facet.data as BrowserActionStep);
    },
    identicalStepsAllowed: (input, objective) => own(objective).filter((x) => isStep(tool, input as Args, x)).length,
    // The request alone determines every argument (element name, role or text); the page is the session's.
    stepFor(facet, objective) {
      const r = req(objective);
      const s = facet.tool === tool && facet.sequence ? r?.steps[facet.sequence.index] : undefined;
      if (!s || s.tool !== tool) return null;
      const input: Args = tool === "browser.fill_field" ? { name: s.name, text: s.text ?? undefined } : { kind: s.kind, name: s.name };
      return this.ground(input, objective).status === "grounded" ? (input as Record<string, unknown>) : null;
    },
    vocabulary: (objective) => {
      const r = requestedBrowserActions(objective);
      return ["on", "at", "the", "page", "site", "open", "go", "to", "visit", "navigate", "load", "and", "then", "click", "type", "enter", "write", "fill", "in", "into", "with",
        "field", "box", "text", "textbox", "input", "search", "button", "link", "checkbox", "check", "radio", "tab", "menu", "item", "please",
        ...(r ? [...contentWords(r.startUrl.replace(/[/:.?=&#_-]+/g, " ")), ...r.steps.flatMap((s) => [...contentWords(s.name), ...contentWords(s.text ?? "")])] : []),
        ...contentWords((objective.match(/\bhttps?:\/\/\S+|\b[\w.-]+\.[a-z]{2,}\S*/gi) ?? []).join(" ").replace(/[/:.?=&#_-]+/g, " "))];
    },
  };
}

interface Progress { next: number; halted: boolean }

export function createBrowserActionTools(sessions: BrowserSessions, bridge: DesktopBridge): ToolSpec<Args, any>[] {
  const offered = () => bridge.available && (bridge.offers ? bridge.offers(DAEMON_TOOL) : true);
  const progress = new Map<string, Progress>();

  const make = (tool: BrowserActionStep["tool"]): ToolSpec<Args, any> => ({
    name: tool,
    description: tool === "browser.click_element"
      ? "Ask the user (in the HUD) to approve ONE click on one element of the web page the user named. Give kind (button, link, checkbox, radio, tab, menuitem) and name exactly as the request says."
      : "Ask the user (in the HUD) to approve filling ONE text field of the web page the user named with the exact quoted text. Give name and text exactly as the request says.",
    inputSchema: tool === "browser.click_element"
      ? { type: "object", properties: { kind: { type: "string", enum: ["button", "link", "checkbox", "radio", "tab", "menuitem"] }, name: { type: "string", minLength: 1, maxLength: 80 } }, required: ["kind", "name"] }
      : { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, text: { type: "string", minLength: 1, maxLength: 500 } }, required: ["name", "text"] },
    permissions: ["network", "request:desktop_action"],
    risk: "medium",
    requiresApproval: false, // the DAEMON's approval, shown in the HUD; this runtime's gate could not show the user anything
    timeoutMs: 90_000,
    async execute(input, ctx) {
      const r = ctx.objective !== undefined && offered() ? requestedBrowserActions(ctx.objective) : null;
      if (!r) return { ok: false, error: "This browser action is not part of the request.", evidence: "" };
      const prog = progress.get(ctx.taskId) ?? { next: 0, halted: false };
      progress.set(ctx.taskId, prog);
      if (prog.halted) return { ok: false, error: "An earlier browser step in this task was not performed and verified; no further step is asked for.", evidence: "" };
      if (prog.next >= r.steps.length) return { ok: false, error: "Every browser step this request contains was already asked for; not asking again.", evidence: "" };
      const want = r.steps[prog.next]!;
      if (!isStep(tool, input, want)) {
        return { ok: false, error: `Out of order: the next browser step is ${prog.next + 1} of ${r.steps.length}: ${describe(want)}. Nothing was sent.`, evidence: "" };
      }
      const pre = r.steps.length > 1 ? `Browser step ${prog.next + 1} of ${r.steps.length}: ` : "";
      const fail = (message: string, output?: unknown) => { prog.halted = true; return { ok: false, ...(output !== undefined ? { output } : {}), error: pre + message, evidence: "" }; };
      const onAbort = () => { void sessions.close(ctx.taskId); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await sessions.open(ctx.taskId, r.startUrl);
        const id = await page.identify(want.kind, want.name);
        if ("code" in id) return fail(`Not asked: ${id.message}. Nothing was done.`);
        const el = id.element;
        const reply = await bridge.call(ctx.taskId, DAEMON_TOOL, {
          kind: tool === "browser.fill_field" ? "fill" : "click", pageUrl: el.pageUrl, pageTitle: await page.title(),
          element: { role: el.role, name: el.name, tag: el.tag, fingerprint: el.fingerprint },
          ...(tool === "browser.fill_field" ? { text: want.text } : {}), ownerPid: process.pid,
        }, ctx.signal, 85_000);
        if (reply.status === "cancelled" || ctx.signal.aborted) return fail("The request was cancelled. Nothing was done.");
        if (reply.status !== "ok") return fail(reply.error?.message ?? "The request was not approved. Nothing was done.");
        const a = reply.result ?? {};
        if (a.consumed !== true || a.elementFingerprint !== el.fingerprint || a.pageUrl !== el.pageUrl) return fail("The approval does not match this element and page. Nothing was done.");
        const evidenceFile = sessions.engine.evidenceDir ? path.join(sessions.engine.evidenceDir, ctx.taskId.replace(/[^\w.-]/g, "_"), `${prog.next + 1}-${tool.split(".")[1]}.png`) : undefined;
        const res = await page.act(want.kind, want.name, el, tool === "browser.fill_field" ? { fill: want.text! } : { click: true }, evidenceFile);
        if ("code" in res) return fail(`You approved it, but ${res.message}. Nothing was done.`);
        const output = { ...res, approvalId: a.approvalId, element: { role: el.role, name: el.name } };
        if (!res.verified) return fail(`It was performed but not confirmed: ${res.observed}.`, output);
        prog.next += 1;
        const what = tool === "browser.fill_field" ? `Filled the ${el.role} "${el.name}"` : `Clicked the ${el.role} "${el.name}"`;
        return { ok: true, output, evidence: `${pre}${what} on ${page.named.host}. Verified: ${res.observed}. Now at "${res.pageTitle}" (${res.pageUrl}).` };
      } catch (e) {
        const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        return fail(e instanceof BrowserPolicyError ? `Not done: ${msg}.` : ctx.signal.aborted ? "Cancelled. The browser was closed." : `The browser step failed: ${msg}`);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
    check(_input, outcome) {
      const o = outcome.output;
      return o && o.executed === true && o.verified === true ? { ok: true } : { ok: false, reason: "the browser action was not performed and verified" };
    },
    requestCheck: actionCheck(tool, offered),
    async endTask(taskId) { progress.delete(taskId); await sessions.close(taskId); },
  });
  return [make("browser.click_element"), make("browser.fill_field")];
}
