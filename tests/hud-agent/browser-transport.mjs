// In a real browser, with the production frontend served by `next start`, a task must still use the HTTP transport
// and must never touch the native bridge. API responses are stubbed at the network layer, so this tests the page's
// transport, not the API routes (the auth and runtime suites cover those).
//
//   node tests/hud-agent/browser-transport.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3977;
let passed = 0, failed = 0;
const check = (ok, name, detail) => {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`); }
};

const server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: ROOT, stdio: "ignore", windowsHide: true });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* not up yet */ }
    if (i > 60) throw new Error("next start did not come up");
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  const calls = [];
  const posted = [];
  await page.route("**/api/assistant", (r) => { calls.push("assistant"); r.fulfill({ json: { reply: "ON IT", actionType: "task" } }); });
  await page.route("**/api/tasks", (r) => { calls.push(`tasks:${r.request().method()}`); posted.push(r.request().postDataJSON()); r.fulfill({ json: { taskId: "browser-task-1" } }); });
  await page.route("**/api/tasks/browser-task-1/events", (r) => {
    calls.push("events");
    const event = { id: "e1", taskId: "browser-task-1", type: "task.completed", timestamp: new Date().toISOString(), payload: { outcome: "completed", finalResponse: "Served over HTTP." } };
    r.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: `data: ${JSON.stringify(event)}\n\n` });
  });
  await page.route("**/api/devices", (r) => r.fulfill({ json: { activeDevice: null, hasPhysicalDevice: false } }));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#ultron-command");

  check(await page.evaluate(() => typeof window.ipc === "undefined"), "no native bridge exists in a browser");
  await page.fill("#ultron-command", "What is 2+2?");
  await page.press("#ultron-command", "Enter");
  await page.getByText("Served over HTTP.").first().waitFor({ timeout: 15000 });

  check(calls.includes("assistant"), "the browser path still goes through /api/assistant", calls);
  check(calls.includes("tasks:POST"), "the task is created with POST /api/tasks", calls);
  check(posted[0]?.objective === "What is 2+2?", "the objective is sent over HTTP", posted[0]);
  check(calls.includes("events"), "progress comes from the HTTP event stream", calls);
  check(await page.getByText("Served over HTTP.").count() > 0, "the panel and history show the HTTP result");
  check(await page.getByText("INDEPENDENTLY VERIFIED").count() === 0, "a browser result does not claim native verification");
} catch (e) {
  check(false, "browser run", String(e));
} finally {
  await browser?.close();
  server.kill();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
