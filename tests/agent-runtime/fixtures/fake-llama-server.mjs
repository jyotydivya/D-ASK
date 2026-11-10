// Stand-in for llama-server used by the supervisor tests. Speaks just enough of
// its CLI and HTTP surface: --host/--port/--device, LLAMA_API_KEY, /health,
// /v1/models, /v1/chat/completions. Behaviour switches come from FAKE_* env vars.
import http from "node:http";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const host = arg("--host");
const port = Number(arg("--port"));
const device = arg("--device");
const key = process.env.LLAMA_API_KEY;
const env = process.env;

// Report what we were started with, for the test to inspect (never the key itself).
console.log(JSON.stringify({
  fakeStarted: true, host, port, device, argv: args,
  hasKey: Boolean(key), keyInArgs: key ? args.some((a) => a.includes(key)) : false,
  leakedEnv: Object.keys(env).filter((k) => /^(LLAMA_|HF_|HUGGING|GGML_)/i.test(k) && k !== "LLAMA_API_KEY"),
}));

if (env.FAKE_FAIL_ON_VULKAN === "1" && device === "Vulkan0") {
  console.error("ggml_vulkan: fake device init failure");
  process.exit(3);
}
if (env.FAKE_EXIT_IMMEDIATELY === "1") process.exit(4);

const loadedAt = Date.now() + Number(env.FAKE_LOAD_MS ?? 0);
const authed = (req) => env.FAKE_NO_AUTH === "1" || req.headers.authorization === `Bearer ${key}`;

const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health") return Date.now() < loadedAt ? send(503, { error: { message: "Loading model" } }) : send(200, { status: "ok" });
  if (!authed(req)) return send(401, { error: { message: "Invalid API Key" } });
  if (req.url === "/v1/models") return send(200, { data: [{ id: "fake" }] });
  if (req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const purpose = parsed.response_format?.json_schema?.name;
      const content = purpose === "assess"
        ? { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "fake" }
        : { intent: "question", goal: "tell the time", successCriteria: ["time shown"], steps: [{ id: "s1", description: "Get time", tool: "system.time", input: {}, dependsOn: [] }] };
      const hold = Number(env.FAKE_HOLD_MS ?? 0);
      setTimeout(() => {
        if (!res.destroyed) send(200, { choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }] });
      }, hold);
    });
    return;
  }
  send(404, { error: { message: "not found" } });
});
server.listen(port, host);

if (env.FAKE_CRASH_AFTER_MS) {
  // With FAKE_CRASH_ONCE_FILE, only the first launch crashes (the marker file records it).
  const once = env.FAKE_CRASH_ONCE_FILE;
  const { existsSync, writeFileSync } = await import("node:fs");
  if (!once || !existsSync(once)) {
    if (once) writeFileSync(once, "crashed");
    setTimeout(() => process.exit(9), Number(env.FAKE_CRASH_AFTER_MS));
  }
}
