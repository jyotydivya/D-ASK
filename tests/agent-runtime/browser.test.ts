/**
 * Browser stage 1: read a web page the user names, in local Chromium.
 * Run with: npx tsx tests/agent-runtime/browser.test.ts        (set DASK_SKIP_LIVE_BROWSER=1 to skip [L])
 *
 *   U. URL policy (pure)            R. request understanding and grounding
 *   E. end-to-end through the real AgentRuntime with a scripted model and a fake engine
 *   L. LIVE: the real local Chromium (Playwright 1243 build) against loopback HTTP servers only. Nothing leaves the machine.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { createHostRegistry as createDefaultRegistry } from "../../agent/runtime/hostRegistry";
import { argumentDomainsFor, clarificationFor, detectFacets, groundCall } from "../../agent/runtime/grounding";
import { checkResolved, checkUrl, isNonPublicAddress, namedSiteOf, urlsIn } from "../../agent/runtime/browser/policy";
import { PlaywrightEngine, type BrowserEngine, type PageReading } from "../../agent/runtime/browser/playwrightEngine";
import { requestedPages } from "../../agent/runtime/tools/browser";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}

const ROOT = process.cwd();
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "network"]);
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted"; calls: StructuredRequest[] = [];
  constructor(private plans: unknown[], private assess: unknown[] = [SAT]) {}
  async generateJson(req: StructuredRequest) { this.calls.push(req); const q = req.purpose === "plan" ? this.plans : this.assess; return structuredClone(q.length > 1 ? q.shift() : q[0]); }
}
const plan = (url: string) => ({ intent: "question", goal: "g", successCriteria: ["read"], steps: [{ id: "s1", description: "read", tool: "browser.read_page", input: { url }, dependsOn: [] }] });
class FakeEngine implements BrowserEngine {
  available = true; calls: string[] = [];
  constructor(private reading: (url: string) => PageReading) {}
  async read(url: string) { this.calls.push(url); return this.reading(url); }
}
const reading = (url: string, extra: Partial<PageReading> = {}): PageReading => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", title: "Example", text: "Hello world",
  textLength: 11, truncated: false, links: [], blocked: [], fetched: 1, readAtUtc: new Date().toISOString(), ...extra });
const run = (engine: BrowserEngine, model: LanguageModel, objective: string) =>
  new AgentRuntime({ model, registry: createDefaultRegistry(ROOT, { browser: engine }), granted: GRANTS }).run({ taskId: `b${Math.random()}`.slice(2), objective });

async function main() {
  console.log("\n[U] URL policy");
  check(urlsIn("What does example.com say?").join() === "https://example.com" && urlsIn("open https://news.ycombinator.com/news.").join() === "https://news.ycombinator.com/news",
    "U1 bare domains get https://; trailing punctuation is not part of the address", [urlsIn("open https://news.ycombinator.com/news.")]);
  check(urlsIn("summarize report.pdf and notes.txt").length === 0 && urlsIn("mail me at a@b.com").length === 0 && urlsIn("version 1.2.3").length === 0,
    "U2 file names, e-mail addresses and version numbers are not web addresses");
  const ex = namedSiteOf("https://example.com/a");
  check(checkUrl("https://example.com/x", ex).allowed && checkUrl("https://cdn.example.com/x.js", ex).allowed && checkUrl("https://www.example.com/", ex).allowed,
    "U3 the named site, its subdomains and www are allowed");
  check(!checkUrl("https://evil.com/", ex).allowed && !checkUrl("https://example.com.evil.com/", ex).allowed && !checkUrl("https://notexample.com/", ex).allowed,
    "U4 other sites, look-alike suffixes and prefixes are refused");
  check(!checkUrl("file:///C:/Windows/win.ini", ex).allowed && !checkUrl("javascript:alert(1)", ex).allowed && !checkUrl("ftp://example.com/", ex).allowed && !checkUrl("https://u:p@example.com/", ex).allowed,
    "U5 only http(s), never credentials in the URL");
  check(isNonPublicAddress("127.0.0.1") && isNonPublicAddress("10.1.2.3") && isNonPublicAddress("192.168.0.1") && isNonPublicAddress("172.20.0.1") && isNonPublicAddress("169.254.169.254")
    && isNonPublicAddress("::1") && isNonPublicAddress("fd00::1") && isNonPublicAddress("::ffff:127.0.0.1") && isNonPublicAddress("localhost") && !isNonPublicAddress("93.184.216.34"),
    "U6 loopback, private, link-local (cloud metadata), ULA and mapped addresses are non-public");
  check(!checkResolved(["10.0.0.5"], ex).allowed && checkResolved(["93.184.216.34"], ex).allowed && !checkResolved([], ex).allowed, "U7 a public name resolving to a private address is refused (rebinding)");
  const loc = namedSiteOf("http://127.0.0.1:8080/");
  check(checkUrl("http://127.0.0.1:8080/x", loc).allowed && !checkUrl("http://127.0.0.1:9000/", loc).allowed && !checkUrl("http://localhost:8080/", loc).allowed && !checkUrl("http://192.168.1.1:8080/", loc).allowed,
    "U8 a local address the user typed: only that host AND port");
  check(!checkUrl("http://169.254.169.254/latest", ex).allowed, "U9 an address the user did not name is never reached");

  console.log("\n[R] Request understanding");
  const reg = createDefaultRegistry(ROOT, { browser: new FakeEngine((u) => reading(u)) });
  check(requestedPages("What does example.com say?").join() === "https://example.com" && requestedPages("Open https://example.org/docs and https://example.net").length === 2, "R1 pages named are pages to read");
  for (const q of ["Log in to example.com", "Click the first link on example.com", "Buy the cheapest item on shop.example.com", "Download the installer from example.com", "Fill in the form at https://example.com/form"]) {
    check(requestedPages(q).length === 0 && /can't click/.test(clarificationFor(reg, q) ?? ""), `R2 page actions are refused before planning: "${q}"`);
  }
  check(/at most 3/.test(clarificationFor(reg, "Read a.com, b.com, c.com and d.com") ?? ""), "R3 more than 3 pages: asked to name fewer");
  check(groundCall(reg, "browser.read_page", { url: "https://example.com" }, "What does example.com say?").status === "grounded"
    && groundCall(reg, "browser.read_page", { url: "https://evil.com" }, "What does example.com say?").status === "contradicted", "R4 the model cannot choose another site");
  const dom = argumentDomainsFor(reg, "What does example.com say?")["browser.read_page"] as any;
  check(dom?.url?.values?.join() === "https://example.com" && (argumentDomainsFor(reg, "What time is it?")["browser.read_page"] as any)?.url?.kind === "forbidden", "R5 the url argument is pinned to the request");
  check(detectFacets(reg, "Summarize https://example.com/post").length === 1 && detectFacets(reg, "What time is it?").filter((f) => f.tool === "browser.read_page").length === 0, "R6 one facet per page");
  check(createDefaultRegistry(ROOT).get("browser.read_page") === undefined, "R7 without an engine (default) the browser tools do not exist");

  console.log("\n[E] End-to-end with a fake engine");
  {
    const e = new FakeEngine((u) => reading(u));
    const r = await run(e, new Scripted([plan("https://example.com")]), "What does example.com say?");
    check(r.outcome === "completed" && e.calls.join() === "https://example.com" && /Hello world/.test(JSON.stringify(r.steps)), "E1 the named page read -> completed", { o: r.outcome });
  }
  {
    const e = new FakeEngine((u) => reading(u, { finalUrl: "https://evil.com/" }));
    const r = await run(e, new Scripted([plan("https://example.com")], [SAT]), "What does example.com say?");
    check(r.outcome !== "completed", "E2 a page that ended up on another site is never completed, even if the model is satisfied", { o: r.outcome });
  }
  {
    const e = new FakeEngine((u) => reading(u, { status: 404 }));
    const r = await run(e, new Scripted([plan("https://example.com")], [SAT]), "What does example.com say?");
    check(r.outcome !== "completed", "E3 HTTP 404 is not a successful reading", { o: r.outcome });
  }
  {
    const e = new FakeEngine((u) => reading(u));
    const r = await run(e, new Scripted([plan("https://evil.com")], [SAT]), "What does example.com say?");
    check(e.calls.length === 0 && r.outcome !== "completed", "E4 a plan for another site never reaches the browser", { o: r.outcome });
  }
  {
    const e = new FakeEngine((u) => reading(u));
    const m = new Scripted([plan("https://example.com")]);
    const r = await new AgentRuntime({ model: m, registry: createDefaultRegistry(ROOT, { browser: e }), granted: DEFAULT_GRANTS }).run({ taskId: "nogrant", objective: "What does example.com say?" });
    check(e.calls.length === 0 && r.outcome !== "completed", "E5 without the network grant the tool cannot run", { o: r.outcome });
  }

  if (process.env.DASK_SKIP_LIVE_BROWSER === "1") { console.log("\n[L] skipped (DASK_SKIP_LIVE_BROWSER=1)"); }
  else {
    console.log("\n[L] LIVE: real local Chromium, loopback servers only");
    let otherHits = 0;
    const other = http.createServer((_q, s) => { otherHits++; s.end("tracked"); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const op = (other.address() as AddressInfo).port;
    const main = http.createServer((q, s) => {
      if (q.url === "/redir") { s.writeHead(302, { location: `http://127.0.0.1:${op}/landing` }); return s.end(); }
      if (q.url === "/file") { s.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.exe" }); return s.end("MZ"); }
      if (q.url === "/ok-redir") { s.writeHead(302, { location: "/" }); return s.end(); }
      if (q.url === "/style.css") { s.writeHead(200, { "content-type": "text/css" }); return s.end("body{}"); }
      s.writeHead(200, { "content-type": "text/html" });
      s.end(`<!doctype html><title>D-ASK Fixture Page</title><link rel=stylesheet href="/style.css"><body><h1>Local fixture</h1><p>The quick brown fox.</p>
        <a href="/about">About us</a><img src="http://localhost:${op}/pixel.png"><img src="https://example.com/x.png">
        <script>fetch("http://127.0.0.1:${op}/beacon").catch(()=>{}); new WebSocket("ws://127.0.0.1:${op}/ws");</script></body>`);
    });
    await new Promise<void>((r) => main.listen(0, "127.0.0.1", r));
    const mp = (main.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${mp}`;
    const engine = new PlaywrightEngine({ navigationTimeoutMs: 15_000 });
    const sig = () => new AbortController().signal;
    try {
      const t0 = Date.now();
      const r = await engine.read(`${base}/`, sig());
      const ms = Date.now() - t0;
      check(r.status === 200 && r.title === "D-ASK Fixture Page" && /quick brown fox/.test(r.text) && r.links.some((l) => l.text === "About us" && l.href === `${base}/about`),
        "L1 the real Chromium read the named page: title, text and links", { title: r.title, text: r.text.slice(0, 80), ms });
      await new Promise((res) => setTimeout(res, 500));
      check(otherHits === 0 && r.blocked.some((b) => b.url.includes(`localhost:${op}`)) && r.blocked.some((b) => b.url.includes("example.com")) && r.blocked.some((b) => b.url.includes(`127.0.0.1:${op}`)),
        "L2 another host, another local port, an external site and a WebSocket were all blocked; the other server got 0 requests", { otherHits, blocked: r.blocked });
      check(r.fetched >= 2, "L3 same-site subresources (the stylesheet) were fetched through the policy", { fetched: r.fetched });
      let redirErr = "";
      try { await engine.read(`${base}/redir`, sig()); } catch (e) { redirErr = String(e); }
      check(redirErr !== "" && otherHits === 0, "L4 a redirect to another local port is refused and never followed", { redirErr: redirErr.slice(0, 160), otherHits });
      const ok = await engine.read(`${base}/ok-redir`, sig());
      check(ok.status === 200 && ok.finalUrl === `${base}/`, "L5 a same-site redirect is followed (each hop checked)", { finalUrl: ok.finalUrl });
      let dlErr = "";
      try { await engine.read(`${base}/file`, sig()); } catch (e) { dlErr = String(e); }
      check(dlErr !== "", "L6 a download is never accepted (the read fails)", dlErr.slice(0, 160));
      let fileErr = "";
      try { await engine.read("file:///C:/Windows/win.ini", sig()); } catch (e) { fileErr = String(e); }
      check(/scheme/.test(fileErr), "L7 file:// is refused before any browser starts", fileErr);
      const ac = new AbortController();
      const p = engine.read(`${base}/`, ac.signal).then(() => "done", () => "aborted");
      ac.abort();
      check((await p) === "aborted", "L8 cancellation closes the browser and fails the read");
      // Through the real runtime: the tool, grounding and verification with the real engine.
      const rr = await new AgentRuntime({ model: new Scripted([plan(`${base}/`)]), registry: createDefaultRegistry(ROOT, { browser: engine }), granted: GRANTS })
        .run({ taskId: "live", objective: `What does ${base}/ say?` });
      check(rr.outcome === "completed" && rr.verification?.independentlyVerified === true, "L9 real runtime + real Chromium: completed and independently verified", { o: rr.outcome, v: rr.verification?.facets });
    } finally {
      main.close(); other.close();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
