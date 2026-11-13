/**
 * Browser stage 2: approved actions in D-ASK's private browser.
 * Run with: npx tsx tests/agent-runtime/browser-actions.test.ts
 *
 *   G. request grammar (pure)        C. refusals / clarification before planning
 *   L. LIVE: the real local Chromium, a loopback fixture site, the real AgentRuntime; the daemon is scripted (its approval
 *      authority is covered by BrowserActionTests.cs). Nothing leaves the machine.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { createHostRegistry as createDefaultRegistry } from "../../agent/runtime/hostRegistry";
import { clarificationFor, groundCall } from "../../agent/runtime/grounding";
import { BrowserSessions, PlaywrightEngine } from "../../agent/runtime/browser/playwrightEngine";
import { requestedBrowserActions } from "../../agent/runtime/tools/browserActions";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const ROOT = process.cwd();
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "network", "read:desktop", "request:desktop_action"]);
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted"; calls: StructuredRequest[] = [];
  constructor(private plans: unknown[], private assess: unknown[] = [SAT]) {}
  async generateJson(req: StructuredRequest) { this.calls.push(req); const q = req.purpose === "plan" ? this.plans : this.assess; return structuredClone(q.length > 1 ? q.shift() : q[0]); }
}
type Step = { tool: string; input: Record<string, unknown> };
const plan = (steps: Step[]) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: steps.map((s, i) => ({ id: `s${i + 1}`, description: s.tool, dependsOn: [], ...s })) });
const fill = (name: string, text: string): Step => ({ tool: "browser.fill_field", input: { name, text } });
const click = (kind: string, name: string): Step => ({ tool: "browser.click_element", input: { kind, name } });

/** Scripted daemon: approves (or denies) and records each request; may run a hook before answering. */
class Daemon implements DesktopBridge {
  available = true;
  calls: { taskId: string; tool: string; args: any }[] = [];
  deny = false;
  hook?: (args: any, taskId: string) => Promise<void>;
  tamper?: (r: any) => any;
  offers(tool: string) { return tool === "browser.request_action"; }
  async call(taskId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DesktopReply> {
    this.calls.push({ taskId, tool, args: structuredClone(args) });
    if (this.hook) await this.hook(args, taskId);
    if (signal.aborted) return { status: "cancelled" };
    if (this.deny) return { status: "error", error: { code: "approval_denied", message: "You declined. Nothing was done." } };
    const r = { decision: "approved", consumed: true, approvalId: `ap${this.calls.length}`, elementFingerprint: (args.element as any).fingerprint, pageUrl: args.pageUrl };
    return { status: "ok", result: this.tamper ? this.tamper(r) : r };
  }
}

async function main() {
  console.log("\n[G] Request grammar");
  const P = "http://127.0.0.1:8080/form";
  const seq = (o: string) => { const r = requestedBrowserActions(o); return r ? `${r.startUrl} | ${r.steps.map((s) => `${s.tool.slice(8)}:${s.kind}:${s.name}${s.text !== null ? `=${s.text}` : ""}`).join(" > ")}` : null; };
  check(seq(`On ${P}, type "me@example.com" into the Email field, then click the Subscribe button`) === `${P} | fill_field:field:Email=me@example.com > click_element:button:Subscribe`, "G1 fill then click, in order", seq(`On ${P}, type "me@example.com" into the Email field, then click the Subscribe button`));
  check(seq("Go to example.com and click the About link") === "https://example.com | click_element:link:About", "G2 go to a site and click a link");
  check(seq(`On ${P}, fill in the Search box with "laptops", then click the "Go" button`) === `${P} | fill_field:field:Search=laptops > click_element:button:Go`, "G3 'fill in X with \"…\"' and a quoted element name");
  check(seq(`On ${P}, click the Newsletter checkbox and click the Save button`) === `${P} | click_element:checkbox:Newsletter > click_element:button:Save`, "G4 checkbox then button");
  check(seq(`On ${P}, type "a, then click the X button" into the Notes field`) === `${P} | fill_field:field:Notes=a, then click the X button`, "G5 separators inside quoted text are text");
  for (const [q, why] of [
    [`On ${P}, type "x" into the Password field`, "a password field"], [`On ${P}, click the Download button`, "download"], [`On ${P}, click the Upload file button`, "upload"],
    [`On ${P}, type "4111 1111" into the credit card field`, "a card number"], [`Click the Go button on ${P}`, "no start phrase"],
    [`On ${P}, click the Go button and then go to https://evil.com`, "a second site"], [`On ${P}, type hello into the Email field`, "unquoted text"],
    [`On ${P}, click the Go button` + ", then click the Go button".repeat(6), "7 steps"], [`On ${P}, click the Go button and close the tab`, "an unparseable step"],
    [`On ${P}, double-click the Go button`, "double-click"],
  ] as const) check(requestedBrowserActions(q) === null, `G6 fail closed: ${why}`, seq(q));

  console.log("\n[C] Refusals before planning");
  const sessionsFake = new BrowserSessions(new PlaywrightEngine());
  const d0 = new Daemon();
  const reg = createDefaultRegistry(ROOT, { browser: new PlaywrightEngine(), browserSessions: sessionsFake, desktop: d0 });
  const q1 = `On ${P}, type "me@example.com" into the Email field, then click the Subscribe button`;
  check(clarificationFor(reg, q1) === null, "C1 offered: a valid action request is not refused");
  check(/never sign in for you/.test(clarificationFor(reg, `Log in to ${P}`) ?? ""), "C2 offered: anything else on a page (sign in) is refused with the supported phrasing");
  const off = createDefaultRegistry(ROOT, { browser: new PlaywrightEngine(), browserSessions: sessionsFake, desktop: Object.assign(new Daemon(), { offers: () => false }) });
  check(/can't click/.test(clarificationFor(off, q1) ?? ""), "C3 not offered by the daemon: refused exactly as in stage 1");
  check(createDefaultRegistry(ROOT, { browser: new PlaywrightEngine() }).get("browser.click_element") === undefined, "C4 without sessions + daemon bridge the action tools do not exist");
  check(groundCall(reg, "browser.fill_field", { name: "Email", text: "me@example.com" }, q1).status === "grounded" && groundCall(reg, "browser.fill_field", { name: "Email", text: "other" }, q1).status === "contradicted"
    && groundCall(reg, "browser.click_element", { kind: "button", name: "Delete account" }, q1).status === "contradicted", "C5 the model cannot change the text or pick another element");

  console.log("\n[L] LIVE: real Chromium, loopback fixture site, real runtime");
  let otherHits = 0;
  const other = http.createServer((_q, s) => { otherHits++; s.end("x"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const op = (other.address() as AddressInfo).port;
  const site = http.createServer((q, s) => {
    if (q.url === "/away") { s.writeHead(302, { location: `http://127.0.0.1:${op}/` }); return s.end(); }
    s.writeHead(200, { "content-type": "text/html" });
    if (q.url === "/about") return s.end("<!doctype html><title>About</title><h1>About this fixture</h1>");
    s.end(`<!doctype html><title>Fixture form</title><body><h1>Newsletter</h1>
      <label for=email>Email</label><input id=email name=email>
      <label for=nick>Customer nickname:</label><input id=nick name=nick>
      <label for=acc>Access</label><input id=acc name=acc type=password>
      <button id=sub onclick="document.getElementById('out').textContent='Thanks, '+document.getElementById('email').value+'!'">Subscribe</button>
      <button>Save</button><button>Save</button><button disabled>Locked</button>
      <a href="/about">About</a> <a href="/away">Partner</a><p id=out></p></body>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dask-browser-evidence-"));
  const engine = new PlaywrightEngine({ navigationTimeoutMs: 15_000, evidenceDir });
  const sessions = new BrowserSessions(engine);
  const runReq = (d: Daemon, m: LanguageModel, objective: string, taskId = `bt${Math.random()}`.replace(".", "")) =>
    new AgentRuntime({ model: m, registry: createDefaultRegistry(ROOT, { browser: engine, browserSessions: sessions, desktop: d }), granted: GRANTS }).run({ taskId, objective });
  const form = `On ${base}/form, type "me@example.com" into the Email field, then click the Subscribe button`;
  try {
    {
      // A label written with a trailing colon ("Customer nickname:") is the same exact name as "Customer nickname" (found with a public test form).
      const d = new Daemon();
      const r = await runReq(d, new Scripted([plan([fill("Customer nickname", "Al")])], [SAT]), `On ${base}/form, type "Al" into the Customer nickname field`, "live-colon");
      check(r.outcome === "completed" && d.calls.length === 1 && d.calls[0]?.args.kind === "fill" && d.calls[0]?.args.text === "Al" && d.calls[0]?.args.element.role === "textbox",
        "L0 a field whose label ends in a colon is found by its name without the colon (exact name otherwise; still unique)", { o: r.outcome, e: r.response });
    }
    {
      const d = new Daemon();
      let thanks = "";
      d.hook = async (args, taskId) => { if (args.kind === "click") { /* nothing yet */ } void taskId; };
      const taskId = "live-l1";
      const origClose = sessions.close.bind(sessions);
      sessions.close = async (t: string) => { if (t === taskId) thanks = (await sessions.get(t)?.page.textContent("#out").catch(() => "")) ?? ""; return origClose(t); };
      const r = await runReq(d, new Scripted([plan([fill("Email", "me@example.com"), click("button", "Subscribe")])]), form, taskId);
      sessions.close = origClose;
      const a0 = d.calls[0]?.args, a1 = d.calls[1]?.args;
      check(r.outcome === "completed" && r.verification?.independentlyVerified === true && d.calls.length === 2 && a0?.kind === "fill" && a0?.text === "me@example.com" && a1?.kind === "click"
        && a0?.element.role === "textbox" && a1?.element.name === "Subscribe" && /^[0-9a-f]{64}$/.test(a0?.element.fingerprint) && a0?.ownerPid === process.pid,
        "L1 fill then click: two separate daemon approvals, in order, each naming the exact element; completed and independently verified", { o: r.outcome, calls: d.calls.map((c) => c.args) });
      check(thanks === "Thanks, me@example.com!", "L2 the page independently shows the effect of both actions", thanks);
      const shots = fs.readdirSync(path.join(evidenceDir, taskId)).sort();
      check(shots.join() === "1-fill_field.png,2-click_element.png", "L3 evidence screenshot captured after each action", shots);
      check(sessions.get(taskId) === undefined && sessions.openCount === 0, "L4 the task's browser is closed when the task ends");
      check(!JSON.stringify(r).includes("cookie") && !JSON.stringify(d.calls).match(/"value"|cookie|storage/i), "L5 nothing sent to the daemon or reported contains field values, cookies or storage");
    }
    {
      // The local model plans only step 1 and says done (observed with desktop input 2026-11-10): step 2 is continued
      // deterministically from the request, separately approved, and the page shows both effects.
      const d = new Daemon();
      const m = new Scripted([plan([fill("Email", "me@example.com")]), plan([fill("Email", "me@example.com")])], [SAT]);
      const taskId = "live-l1b";
      let thanks = "";
      const origClose = sessions.close.bind(sessions);
      sessions.close = async (t: string) => { if (t === taskId) thanks = (await sessions.get(t)?.page.textContent("#out").catch(() => "")) ?? ""; return origClose(t); };
      const r = await runReq(d, m, form, taskId);
      sessions.close = origClose;
      check(r.outcome === "completed" && d.calls.map((c) => c.args.kind).join(",") === "fill,click" && m.calls.filter((c) => c.purpose === "plan").length === 1 && thanks === "Thanks, me@example.com!",
        "L1b only the fill planned and the model says done -> the click is continued from the request (one model plan), approved separately, completed", { o: r.outcome, calls: d.calls.map((c) => c.args.kind), thanks });
    }
    {
      const d = new Daemon(); d.deny = true;
      const r = await runReq(d, new Scripted([plan([fill("Email", "me@example.com"), click("button", "Subscribe")]), plan([click("button", "Subscribe")])]), form);
      check(d.calls.length === 1 && r.outcome !== "completed", "L6 step 1 denied: nothing filled, step 2 never asked for, not even by a re-plan", { o: r.outcome, calls: d.calls.length });
    }
    {
      const d = new Daemon();
      const r = await runReq(d, new Scripted([plan([click("button", "Subscribe"), fill("Email", "me@example.com")])], [SAT]), form);
      check(d.calls.length === 0 && r.outcome !== "completed", "L7 a plan in the wrong order never reaches the daemon", { o: r.outcome });
    }
    {
      const d = new Daemon();
      const r = await runReq(d, new Scripted([plan([click("link", "About")])]), `Go to ${base}/form and click the About link`);
      check(r.outcome === "completed" && /moved to .*\/about/.test(JSON.stringify(r.steps)), "L8 clicking a same-site link navigates; verified by the new address", { o: r.outcome });
    }
    {
      const d = new Daemon();
      const r = await runReq(d, new Scripted([plan([click("button", "Save")])], [SAT]), `On ${base}/form, click the Save button`);
      check(d.calls.length === 0 && r.outcome !== "completed" && /won't guess/.test(JSON.stringify(r.steps)), "L9 two matching elements: refused before any approval", { o: r.outcome });
      const r2 = await runReq(d, new Scripted([plan([click("button", "Locked")])], [SAT]), `On ${base}/form, click the Locked button`);
      check(d.calls.length === 0 && r2.outcome !== "completed", "L10 a disabled element: refused before any approval");
    }
    {
      const g = await engine.openPage(`${base}/form`);
      await g.goto(`${base}/form`);
      const id = await g.identify("field", "Access");
      check("code" in id && id.code === "secret_field", "L11 a password field is never identified for filling (even under a harmless label)", id);
      await g.close();
    }
    {
      const d = new Daemon();
      d.hook = async (_a, taskId) => { await sessions.get(taskId)?.page.evaluate(() => { document.getElementById("sub")!.id = "changed"; }); };
      const r = await runReq(d, new Scripted([plan([click("button", "Subscribe")])], [SAT]), `On ${base}/form, click the Subscribe button`);
      check(d.calls.length === 1 && r.outcome !== "completed" && /changed after your approval/.test(JSON.stringify(r.steps)), "L12 the element changed between approval and action: not clicked", { o: r.outcome, steps: r.steps.map((s) => s.error) });
    }
    {
      const d = new Daemon(); d.tamper = (r) => ({ ...r, elementFingerprint: "f".repeat(64) });
      const r = await runReq(d, new Scripted([plan([click("button", "Subscribe")])], [SAT]), `On ${base}/form, click the Subscribe button`);
      check(r.outcome !== "completed" && /does not match/.test(JSON.stringify(r.steps)), "L13 an approval for another element is never used", { o: r.outcome });
    }
    {
      const d = new Daemon();
      const r = await runReq(d, new Scripted([plan([click("link", "Partner")])], [SAT]), `On ${base}/form, click the Partner link`);
      await new Promise((res) => setTimeout(res, 300));
      check(r.outcome !== "completed" && otherHits === 0, "L14 a link that redirects off-site is not followed; the other site got 0 requests", { o: r.outcome, otherHits, err: r.steps.map((s) => s.error) });
    }
    {
      const d = new Daemon();
      const ac = new AbortController();
      d.hook = async () => { ac.abort(); };
      const taskId = "live-cancel";
      const r = await new AgentRuntime({ model: new Scripted([plan([click("button", "Subscribe")])]), registry: createDefaultRegistry(ROOT, { browser: engine, browserSessions: sessions, desktop: d }), granted: GRANTS })
        .run({ taskId, objective: `On ${base}/form, click the Subscribe button`, signal: ac.signal } as any);
      check(r.outcome !== "completed" && sessions.get(taskId) === undefined, "L15 cancellation (Emergency Stop) while waiting for approval: nothing done, browser closed", { o: r.outcome });
    }
    {
      // Opt-in persistence: a session cookie survives into a later session ONLY with D-ASK's own persistent profile.
      const login = http.createServer((q, s) => {
        if (q.url === "/login") { s.writeHead(200, { "set-cookie": "sid=abc; Path=/; Max-Age=3600", "content-type": "text/html" }); return s.end("<title>in</title>signed in"); }
        s.writeHead(200, { "content-type": "text/html" }); s.end(`<title>who</title>${/sid=abc/.test(q.headers.cookie ?? "") ? "WELCOME BACK" : "ANONYMOUS"}`);
      });
      await new Promise<void>((r) => login.listen(0, "127.0.0.1", r));
      const lb = `http://127.0.0.1:${(login.address() as AddressInfo).port}`;
      const who = async (e: PlaywrightEngine) => { const g = await e.openPage(`${lb}/login`); await g.goto(`${lb}/login`); await g.close();
        const g2 = await e.openPage(`${lb}/who`); const resp = await g2.goto(`${lb}/who`); const t = (await g2.reading(`${lb}/who`, resp)).text; await g2.close(); return t; };
      const profileDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dask-prof-")), "D-ASK", "browser-profile");
      try {
        const fresh = await who(new PlaywrightEngine());
        const kept = await who(new PlaywrightEngine({ profileDir }));
        check(fresh === "ANONYMOUS" && kept === "WELCOME BACK", "L16 default: every session starts signed out; opt-in D-ASK profile: the sign-in is kept", { fresh, kept });
        check(!kept.includes("sid=") && !fresh.includes("sid="), "L17 the cookie itself never appears in what the agent receives");
      } finally { login.close(); }
    }
  } finally {
    await sessions.closeAll();
    site.close(); other.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
