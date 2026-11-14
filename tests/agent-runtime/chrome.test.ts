/**
 * The user's Chrome, agent side (2026-11-14). Run with: npx tsx tests/agent-runtime/chrome.test.ts
 * Real Chrome end to end (extension + native host + broker + daemon) is covered by ChromeLiveTests.cs.
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { actuationRefusal, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import { chromeRequest } from "../../agent/runtime/tools/chrome";
import { requestedBrowserActions } from "../../agent/runtime/tools/browserActions";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { passed++; console.log("  PASS: " + l); } else { failed++; console.error("  FAIL: " + l + (d !== undefined ? ` | ${JSON.stringify(d)}` : "")); } };
const ROOT = path.resolve(__dirname, "..", "..");
class FakeDaemon implements DesktopBridge {
  available = true; calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private replies: DesktopReply[]) {}
  async call(_t: string, tool: string, args: Record<string, unknown>) { this.calls.push({ tool, args }); return structuredClone(this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!); }
}
const plan = (steps: { id: string; tool: string; input: Record<string, unknown> }[]) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: steps.map((s) => ({ description: s.tool, dependsOn: [], ...s })) });
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private p: unknown) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? this.p : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" }); }
}
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
const run = (b: DesktopBridge, m: LanguageModel, o: string) => new AgentRuntime({ model: m, registry: createDefaultRegistry(ROOT, { desktop: b }), granted: GRANTS }).run({ taskId: `t${Math.random()}`.replace(".", ""), objective: o });

async function main() {
  console.log("\n[G] Grammar (only requests that name Chrome)");
  const cases: [string, unknown][] = [
    ["Open github.com in Chrome", { tool: "chrome.open", args: { url: "github.com" } }],
    ["Go to https://example.com/docs in my Chrome", { tool: "chrome.open", args: { url: "https://example.com/docs" } }],
    ["Open a new tab with wikipedia.org in Chrome", { tool: "chrome.open_tab", args: { url: "wikipedia.org" } }],
    ["List my Chrome tabs", { tool: "chrome.list_tabs", args: {} }],
    ['Switch to the "Inbox" tab in Chrome', { tool: "chrome.switch_tab", args: { title: "Inbox" } }],
    ["Read the page in Chrome", { tool: "chrome.read_page", args: {} }],
    ['Click "Sign in" in Chrome', { tool: "chrome.click", args: { text: "Sign in" } }],
    ['Click the link "Go to page two" in Chrome', { tool: "chrome.click", args: { text: "Go to page two" } }],
    ['Type "Test User" into the "Your name" field in Chrome', { tool: "chrome.fill", args: { text: "Test User", field: "Your name" } }],
    ['Search for "weather in Pune" in Chrome', { tool: "chrome.search", args: { query: "weather in Pune" } }],
    ["Stop controlling my Chrome", { tool: "chrome.revoke", args: {} }],
    ["Let D-ASK control my Chrome", { tool: "chrome.authorize", args: {} }],
    ["Is my Chrome connected?", { tool: "chrome.status", args: {} }],
  ];
  for (const [q, want] of cases) check(JSON.stringify(chromeRequest(q)) === JSON.stringify(want), `G ${q}`, chromeRequest(q));
  for (const q of ["Open github.com", "Open Chrome", "Click the OK button in Notepad", "Read the page https://example.com"])
    check(chromeRequest(q) === null, `G not a Chrome-control request: ${q}`);
  check(requestedBrowserActions('Click "Sign in" in Chrome') === null || chromeRequest('Click "Sign in" in Chrome') !== null, "G the private-browser grammar keeps its own requests");
  check(actuationRefusal('Click "Sign in" in Chrome') === null, "G a Chrome click is an approval-gated request, not refused");

  console.log("\n[E] End to end");
  {
    const d = new FakeDaemon([{ status: "ok", result: { executed: true, verified: true, tabId: 5, url: "https://github.com/", title: "GitHub", observed: "Chrome shows \"GitHub\" at https://github.com/" } } as any]);
    const r = await run(d, new Scripted(plan([{ id: "s1", tool: "chrome.open", input: { url: "github.com" } }])), "Open github.com in Chrome");
    check(r.outcome === "completed" && d.calls[0]?.tool === "chrome.open" && (d.calls[0]!.args as any).url === "github.com" && /GitHub/.test(r.response), "E1 open a site in Chrome; completed from Chrome's reported address", { o: r.outcome, r: r.response });
    const d2 = new FakeDaemon([{ status: "ok", result: { verified: true } } as any]);
    const r2 = await run(d2, new Scripted(plan([{ id: "s1", tool: "chrome.open", input: { url: "evil.example" } }])), "Open github.com in Chrome");
    check(r2.outcome !== "completed" && d2.calls.length === 0, "E2 a different address planned by the model never reaches Chrome");
  }
  {
    const d = new FakeDaemon([{ status: "error", error: { code: "approval_denied", message: "You declined. Nothing was done." } } as any]);
    const r = await run(d, new Scripted(plan([{ id: "s1", tool: "chrome.click", input: { text: "Buy now" } }])), 'Click "Buy now" in Chrome');
    check(r.outcome !== "completed" && /declined/i.test(r.response), "E3 a declined sensitive click is reported as not done", { o: r.outcome, r: r.response });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
