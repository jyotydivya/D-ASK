// ─────────────────────────────────────────────────────────────────────────────
// Local Chromium (Playwright's installed build), guarded. Stage 1 reads a page (one fresh browser per read); stage 2 keeps
// ONE guarded page per task for approved actions (BrowserSessions). In both:
//   - Chromium itself can resolve NO host name (--host-resolver-rules MAP * ~NOTFOUND) and has background services off,
//     so the only way a byte leaves the machine is through the route handler below;
//   - every request (document, subresource, every redirect hop) goes through policy.checkUrl, then DNS is checked for
//     private addresses (rebinding), then Node fetches it with redirects OFF; redirects are followed here, hop by hop;
//   - no downloads, WebSockets, service workers, dialogs or popups; no user profile (or, opt-in, D-ASK's OWN profile);
//   - nothing returned to the agent ever contains field values, cookies, storage or credentials.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page, Response } from "playwright";
import { BrowserPolicyError, checkResolved, checkUrl, namedSiteOf, type NamedSite } from "./policy";

export interface PageReading {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  textLength: number;
  truncated: boolean;
  links: { text: string; href: string }[];
  /** Requests the policy refused (URL and reason), e.g. a third-party script or an off-site redirect. */
  blocked: { url: string; reason: string }[];
  /** Requests fetched on the page's behalf (same site only). */
  fetched: number;
  readAtUtc: string;
}

export interface BrowserEngine {
  readonly available: boolean;
  read(url: string, signal: AbortSignal): Promise<PageReading>;
}

export interface PlaywrightEngineOptions {
  maxTextChars?: number;
  maxLinks?: number;
  navigationTimeoutMs?: number;
  /** Test seam: name resolution (default: the OS resolver). */
  resolve?: (host: string) => Promise<string[]>;
  /** Opt-in: D-ASK's OWN persistent profile directory (never an everyday browser profile). Absent: in-memory, per session. */
  profileDir?: string;
  /** Where action evidence (screenshots) is written. Absent: none written. */
  evidenceDir?: string;
}

/**
 * Playwright from the repository, or playwright-core as shipped in the package (it has no dependencies). Loaded lazily.
 * Either way the browser itself is found by launchChromium below.
 */
function loadChromium(): typeof import("playwright").chromium {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("playwright") as typeof import("playwright")).chromium;
  } catch (e) {
    if ((e as { code?: string }).code !== "MODULE_NOT_FOUND") throw e;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("playwright-core") as typeof import("playwright")).chromium;
  }
}

/**
 * Playwright's own Chromium when it is installed (development machines); otherwise the Microsoft Edge or Chrome that Windows already has,
 * so the packaged application needs no browser download. The same locked-down arguments, routing and policy apply to either browser.
 */
async function launchChromium<T>(chromium: ReturnType<typeof loadChromium>, start: (channel?: "msedge" | "chrome") => Promise<T>): Promise<T> {
  try { return await start(); }
  catch (first) {
    if (!/Executable doesn't exist/i.test(String((first as Error)?.message ?? first))) throw first;
    void chromium;
    for (const channel of ["msedge", "chrome"] as const) {
      try { return await start(channel); } catch { /* try the next installed browser */ }
    }
    throw new Error("No browser is available: Playwright's Chromium is not installed and neither Microsoft Edge nor Google Chrome could be started.");
  }
}

const CHROMIUM_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-domain-reliability",
  "--disable-client-side-phishing-detection", "--no-pings", "--no-first-run", "--dns-prefetch-disable",
  "--disable-features=NetworkPrediction,OptimizationHints,MediaRouter,AutofillServerCommunication,Translate,PasswordManagerOnboarding",
  "--password-store=basic",
];
const MAX_REDIRECTS = 5;

export { BrowserPolicyError };

/** D-ASK's own browser profile (opt-in persistence). Never the user's Chrome/Edge profile. */
export function daskProfileDir(): string {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "D-ASK", "browser-profile");
}

// ── one guarded page ────────────────────────────────────────────────────────

/** What the request may target: role names the request's nouns map to (Playwright/ARIA roles). */
export type ElementKind = "button" | "link" | "checkbox" | "radio" | "tab" | "menuitem" | "field";
const KIND_ROLES: Record<ElementKind, readonly ("button" | "link" | "checkbox" | "radio" | "tab" | "menuitem" | "textbox" | "searchbox" | "combobox")[]> = {
  button: ["button"], link: ["link"], checkbox: ["checkbox"], radio: ["radio"], tab: ["tab"], menuitem: ["menuitem"], field: ["textbox", "searchbox", "combobox"],
};
const SECRET_FIELD = /pass(word|wd|phrase|code)?|secret|token|api[ _.-]?key|credential|\bpin\b|otp|one[- ]time|cvv|cvc|card\s*number|security\s*code/i;

export interface IdentifiedElement {
  role: string;
  /** The accessible name as the page exposes it (the request's name, matched exactly, case-insensitively). */
  name: string;
  tag: string;
  fingerprint: string;
  pageUrl: string;
}

export type ElementRefusal = { code: "not_found" | "ambiguous" | "secret_field" | "disabled" | "not_editable" | "cross_frame"; message: string };

export interface ActionResult {
  executed: boolean;
  verified: boolean;
  observed: string;
  pageUrl: string;
  pageTitle: string;
  navigated: boolean;
  evidencePath?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class GuardedPage {
  readonly named: NamedSite;
  readonly blocked: PageReading["blocked"] = [];
  fetched = 0;
  private navRedirect: string | null = null;
  private lastMain: Response | null = null;
  private closed = false;

  private constructor(private readonly engine: PlaywrightEngine, readonly startUrl: string, private readonly browser: Browser | null,
    private readonly context: BrowserContext, readonly page: Page) {
    this.named = namedSiteOf(startUrl);
  }

  /** Opens a locked-down page for the site of `url` (nothing is loaded yet). */
  static async open(engine: PlaywrightEngine, url: string, profileDir?: string): Promise<GuardedPage> {
    const named = namedSiteOf(url);
    const first = checkUrl(url, named);
    if (!first.allowed) throw new BrowserPolicyError(first.reason);
    // Loaded lazily: the agent host never loads Playwright unless browsing is enabled and used.
    const chromium = loadChromium();
    const ctxOpts = { acceptDownloads: false, serviceWorkers: "block" as const, javaScriptEnabled: true, permissions: [] as string[], bypassCSP: false };
    let browser: Browser | null = null;
    let context: BrowserContext;
    if (profileDir) {
      mkdirSync(profileDir, { recursive: true });
      context = await launchChromium(chromium, (channel) => chromium.launchPersistentContext(profileDir, { headless: true, args: CHROMIUM_ARGS, ...(channel ? { channel } : {}), ...ctxOpts }));
    } else {
      browser = await launchChromium(chromium, (channel) => chromium.launch({ headless: true, args: CHROMIUM_ARGS, ...(channel ? { channel } : {}) }));
      context = await browser.newContext(ctxOpts);
    }
    const page = context.pages()[0] ?? await context.newPage();
    const g = new GuardedPage(engine, url, browser, context, page);
    await g.lockDown();
    return g;
  }

  private async lockDown(): Promise<void> {
    const { context, page } = this;
    await context.routeWebSocket(/.*/, (ws) => { this.block(ws.url(), "WebSockets are not allowed"); Promise.resolve(ws.close()).catch(() => undefined); });
    // Playwright does not route the browser's own redirect follow-ups, so redirects are followed HERE, every hop checked.
    // A main-frame redirect becomes a new navigation (follow()) so the page keeps its real address.
    await context.route("**/*", async (route) => {
      const req = route.request();
      let mainFrameNav = false;
      try { mainFrameNav = req.isNavigationRequest() && req.frame().parentFrame() === null; } catch { /* a worker request */ }
      let target = req.url();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const verdict = await this.engine.allowed(target, this.named);
        if (!verdict.allowed) { this.block(target, verdict.reason); return route.abort("blockedbyclient"); }
        let response;
        try { response = await route.fetch({ url: target, maxRedirects: 0, timeout: this.engine.navTimeout }); } catch { return route.abort("failed"); }
        this.fetched += 1;
        const location = response.status() >= 300 && response.status() < 400 ? response.headers()["location"] : undefined;
        if (!location) return route.fulfill({ response });
        const next = new URL(location, target).href;
        if (mainFrameNav) { this.navRedirect = next; return route.fulfill({ status: 200, contentType: "text/html", body: "" }); }
        target = next;
      }
      this.block(target, "too many redirects");
      return route.abort("blockedbyclient");
    });
    context.on("page", (p) => { if (p !== page) { this.block(p.url() || "popup", "new windows and popups are not allowed"); p.close().catch(() => undefined); } });
    page.on("download", (d) => { this.block(d.url(), "downloads are not allowed"); d.cancel().catch(() => undefined); });
    page.on("dialog", (d) => { d.dismiss().catch(() => undefined); });
    page.on("filechooser", () => { this.block("file chooser", "choosing local files is not allowed"); });
    page.on("response", (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) this.lastMain = r; } catch { /* detached */ } });
  }

  private block(url: string, reason: string) { if (this.blocked.length < 50) this.blocked.push({ url: url.slice(0, 200), reason }); }

  /** Navigates within the named site; follows redirects hop by hop; the final address must be the named site. */
  async goto(url: string): Promise<Response | null> {
    let response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.engine.navTimeout });
    response = (await this.follow()) ?? response;
    this.assertOnSite();
    await this.page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
    return response ?? this.lastMain;
  }

  private async follow(): Promise<Response | null> {
    let response: Response | null = null;
    for (let hop = 0; this.navRedirect !== null; hop++) {
      const next: string = this.navRedirect;
      this.navRedirect = null;
      const v = checkUrl(next, this.named);
      if (!v.allowed || hop >= MAX_REDIRECTS) throw new BrowserPolicyError(`the page redirects elsewhere: ${v.allowed ? "too many redirects" : v.reason}`);
      response = await this.page.goto(next, { waitUntil: "domcontentloaded", timeout: this.engine.navTimeout });
    }
    return response;
  }

  private assertOnSite() {
    const v = checkUrl(this.page.url(), this.named);
    if (!v.allowed) throw new BrowserPolicyError(`the page ended up elsewhere: ${v.reason}`);
  }

  async reading(requestedUrl: string, response: Response | null): Promise<PageReading> {
    const data = await this.page.evaluate((maxLinks: number) => {
      const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      const links = Array.from(document.querySelectorAll("a[href]")).slice(0, maxLinks * 3)
        .map((a) => ({ text: ((a as HTMLAnchorElement).innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.text && /^https?:/.test(l.href)).slice(0, maxLinks);
      return { title: document.title, text, links };
    }, this.engine.maxLinks);
    const r = response ?? this.lastMain;
    return {
      requestedUrl, finalUrl: this.page.url(), status: r?.status() ?? 0, contentType: (await r?.headerValue("content-type").catch(() => null)) ?? "",
      title: data.title.slice(0, 300), text: data.text.slice(0, this.engine.maxText), textLength: data.text.length, truncated: data.text.length > this.engine.maxText,
      links: data.links, blocked: this.blocked.slice(0, 50), fetched: this.fetched, readAtUtc: new Date().toISOString(),
    };
  }

  // ── element identity ──

  private candidates(kind: ElementKind, name: string): Locator[] {
    // Exact accessible name (case-insensitive), allowing the one punctuation mark forms put after a label: "Customer name:" is "Customer name".
    const re = new RegExp(`^\\s*${escapeRe(name.trim())}\\s*:?\\s*$`, "i");
    return KIND_ROLES[kind].map((role) => this.page.getByRole(role, { name: re }).filter({ visible: true }));
  }

  /** Exactly one visible, enabled element of that kind with exactly that accessible name, in the main frame; never a secret field. */
  async identify(kind: ElementKind, name: string): Promise<{ element: IdentifiedElement; locator: Locator } | ElementRefusal> {
    this.assertOnSite();
    const found: { loc: Locator; role: string }[] = [];
    const roles = KIND_ROLES[kind];
    const locs = this.candidates(kind, name);
    for (let i = 0; i < locs.length; i++) {
      const n = await locs[i]!.count();
      for (let k = 0; k < n; k++) found.push({ loc: locs[i]!.nth(k), role: roles[i]! });
    }
    if (found.length === 0) return { code: "not_found", message: `no visible ${kind === "field" ? "field" : kind} named "${name}" on this page` };
    if (found.length > 1) return { code: "ambiguous", message: `${found.length} elements named "${name}" match; I won't guess which one` };
    const { loc, role } = found[0]!;
    const facts = await loc.evaluate((el) => {
      const e = el as HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(), type: (e.type || "").toLowerCase(), id: el.id || "", nameAttr: el.getAttribute("name") || "",
        autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(), href: (el as HTMLAnchorElement).href || "",
        formAction: e.form ? e.form.action : "", ariaLabel: el.getAttribute("aria-label") || "", label: e.labels?.[0]?.innerText?.trim() ?? "",
        placeholder: el.getAttribute("placeholder") || "", text: ((el as HTMLElement).innerText || "").trim().slice(0, 200),
        disabled: (e.disabled === true) || el.getAttribute("aria-disabled") === "true",
        editable: !e.readOnly && !(e.disabled === true), sameDoc: el.ownerDocument === document,
      };
    });
    if (!facts.sameDoc) return { code: "cross_frame", message: "the element is inside another frame" };
    const secretish = facts.type === "password" || /password|cc-|one-time-code/.test(facts.autocomplete) ||
      [name, facts.nameAttr, facts.id, facts.label, facts.placeholder, facts.ariaLabel].some((s) => SECRET_FIELD.test(s));
    if (kind === "field" && secretish) return { code: "secret_field", message: "that looks like a password or payment-secret field; D-ASK never fills those (sign in yourself)" };
    if (facts.disabled) return { code: "disabled", message: `"${name}" is disabled` };
    if (kind === "field" && !facts.editable) return { code: "not_editable", message: `"${name}" cannot be edited` };
    const accessible = (facts.ariaLabel || facts.label || facts.text || facts.placeholder || name).trim().slice(0, 200);
    const fingerprint = sha(JSON.stringify({ role, name: name.trim().toLowerCase(), tag: facts.tag, type: facts.type, id: facts.id, nameAttr: facts.nameAttr,
      href: facts.href, formAction: facts.formAction, page: this.page.url() }));
    return { element: { role, name: accessible, tag: facts.tag, fingerprint, pageUrl: this.page.url() }, locator: loc };
  }

  /** After approval: the same page, and exactly the same element (same fingerprint), still usable. */
  private async revalidate(kind: ElementKind, requestName: string, approved: IdentifiedElement): Promise<Locator | ElementRefusal> {
    if (this.page.url() !== approved.pageUrl) return { code: "not_found", message: "the page changed after your approval" };
    const now = await this.identify(kind, requestName);
    if ("code" in now) return now;
    if (now.element.fingerprint !== approved.fingerprint) return { code: "not_found", message: "the element changed after your approval" };
    return now.locator;
  }

  private async snapshot(loc: Locator | null) {
    const page = await this.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input,select,textarea")).map((e) => `${(e as HTMLInputElement).checked ?? ""}|${(e as HTMLInputElement).value?.length ?? ""}`).join(";");
      return `${document.title}\n${document.body?.innerText ?? ""}\n${inputs}`;
    }).catch(() => "");
    const checked = loc ? await loc.evaluate((el) => String((el as HTMLInputElement).checked ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? "")).catch(() => "") : "";
    return { url: this.page.url(), hash: sha(page), checked };
  }

  /** Performs ONE approved action after revalidation, then verifies its effect independently. */
  async act(kind: ElementKind, requestName: string, approved: IdentifiedElement, action: { click: true } | { fill: string }, evidenceFile?: string): Promise<ActionResult | ElementRefusal> {
    const loc = await this.revalidate(kind, requestName, approved);
    if ("code" in loc) return loc;
    const before = await this.snapshot(loc);
    let observed = "";
    let verified = false;
    let navigated = false;
    if ("fill" in action) {
      await loc.fill(action.fill, { timeout: 5000 });
      const value = await loc.inputValue({ timeout: 2000 });
      verified = value === action.fill;
      observed = verified ? `the field now holds exactly the ${action.fill.length} approved character(s)` : "the field does not hold exactly the approved text";
    } else {
      await loc.click({ timeout: 5000 });
      // Navigation (if any) completes within the named site; redirects are followed hop by hop.
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      await this.follow();
      this.assertOnSite();
      const deadline = Date.now() + 2000;
      let after = await this.snapshot(this.page.url() === before.url ? loc : null);
      while (Date.now() < deadline && after.url === before.url && after.hash === before.hash && after.checked === before.checked) {
        await new Promise((r) => setTimeout(r, 100));
        after = await this.snapshot(this.page.url() === before.url ? loc : null);
      }
      navigated = after.url !== before.url;
      verified = navigated || after.hash !== before.hash || after.checked !== before.checked;
      observed = navigated ? `the page moved to ${after.url}` : after.checked !== before.checked ? "the element's checked/selected state changed" : verified ? "the page's content changed after the click" : "no observable change after the click";
    }
    let evidencePath: string | undefined;
    if (evidenceFile) {
      try { mkdirSync(path.dirname(evidenceFile), { recursive: true }); await this.page.screenshot({ path: evidenceFile, timeout: 5000 }); evidencePath = evidenceFile; } catch { /* evidence is best effort; verification is not */ }
    }
    return { executed: true, verified, observed, pageUrl: this.page.url(), pageTitle: (await this.page.title().catch(() => "")).slice(0, 300), navigated, evidencePath };
  }

  async title(): Promise<string> { return (await this.page.title().catch(() => "")).slice(0, 300); }
  get url(): string { return this.page.url(); }
  get isClosed(): boolean { return this.closed; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    if (this.browser) await this.browser.close().catch(() => undefined);
  }
}

// ── engine ──────────────────────────────────────────────────────────────────

export class PlaywrightEngine implements BrowserEngine {
  readonly available = true;
  readonly maxText: number;
  readonly maxLinks: number;
  readonly navTimeout: number;
  readonly profileDir?: string;
  readonly evidenceDir?: string;
  private readonly resolve: (host: string) => Promise<string[]>;

  constructor(opts: PlaywrightEngineOptions = {}) {
    this.maxText = opts.maxTextChars ?? 8000;
    this.maxLinks = opts.maxLinks ?? 40;
    this.navTimeout = opts.navigationTimeoutMs ?? 20_000;
    this.resolve = opts.resolve ?? (async (h) => (await lookup(h, { all: true })).map((a) => a.address));
    this.profileDir = opts.profileDir;
    this.evidenceDir = opts.evidenceDir;
  }

  /** Stage 1: one fresh, in-memory browser per read (never the persistent profile). */
  async read(url: string, signal: AbortSignal): Promise<PageReading> {
    const g = await GuardedPage.open(this, url);
    const abort = () => { void g.close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await g.goto(url);
      if (signal.aborted) throw new Error("cancelled");
      if (!response) throw new Error("the page did not load");
      return await g.reading(url, response);
    } finally {
      signal.removeEventListener("abort", abort);
      await g.close();
    }
  }

  /** Stage 2: a page for a task's session (the persistent D-ASK profile only if configured). */
  openPage(url: string): Promise<GuardedPage> { return GuardedPage.open(this, url, this.profileDir); }

  async allowed(url: string, named: NamedSite) {
    const v = checkUrl(url, named);
    if (!v.allowed) return v;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return checkResolved([host], named);
    try { return checkResolved(await this.resolve(host), named); } catch { return { allowed: false as const, reason: "the name did not resolve" }; }
  }
}

// ── per-task sessions ───────────────────────────────────────────────────────

/** One guarded page per task, opened on the request's start page, closed when the task ends, on abort, or when idle. */
export class BrowserSessions {
  private readonly sessions = new Map<string, { page: GuardedPage; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly engine: PlaywrightEngine, private readonly idleMs = 5 * 60_000) {}

  async open(taskId: string, startUrl: string): Promise<GuardedPage> {
    const s = this.sessions.get(taskId);
    if (s && !s.page.isClosed) {
      if (s.page.named.host !== namedSiteOf(startUrl).host) throw new BrowserPolicyError("this task's browser is for another site");
      this.touch(taskId);
      return s.page;
    }
    const page = await this.engine.openPage(startUrl);
    try {
      const response = await page.goto(startUrl);
      if (!response || response.status() >= 400) throw new Error(`the start page answered HTTP ${response?.status() ?? "nothing"}`);
    } catch (e) { await page.close(); throw e; }
    this.sessions.set(taskId, { page, timer: setTimeout(() => void this.close(taskId), this.idleMs) });
    return page;
  }

  private touch(taskId: string) {
    const s = this.sessions.get(taskId);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.close(taskId), this.idleMs);
  }

  async close(taskId: string): Promise<void> {
    const s = this.sessions.get(taskId);
    if (!s) return;
    this.sessions.delete(taskId);
    clearTimeout(s.timer);
    await s.page.close();
  }

  /** The task's open page, if any (diagnostics and tests). */
  get(taskId: string): GuardedPage | undefined { const s = this.sessions.get(taskId); return s && !s.page.isClosed ? s.page : undefined; }

  async closeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map((t) => this.close(t))); }
  get openCount(): number { return this.sessions.size; }
}
