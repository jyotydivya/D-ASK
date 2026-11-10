// Plugin sandbox runner: executed as `node --permission --allow-fs-read=<sealed copy> --allow-fs-read=<this folder>
// --disallow-code-generation-from-strings --max-old-space-size=96 --require sandboxPreload.cjs sandboxRunner.cjs`.
// Reads ONE request line from stdin: {"entry": "<file in the sealed copy>", "tool": "<export name>", "input": {...}}, calls the
// plugin's exported function once, and writes ONE result line: {"ok":true,"output":…,"text":"…"} or {"ok":false,"error":"…"}.
"use strict";
const path = require("node:path");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; if (raw.length > 65536) { write({ ok: false, error: "request too large" }); process.exit(2); } });
process.stdin.on("end", async () => {
  let req;
  try { req = JSON.parse(raw); } catch { write({ ok: false, error: "malformed request" }); return; }
  try {
    const mod = require(path.resolve(req.entry));
    const fn = mod && mod[req.tool];
    if (typeof fn !== "function") { write({ ok: false, error: `the plugin does not export ${req.tool}` }); return; }
    const out = await fn(req.input);
    const text = out && typeof out.text === "string" ? out.text : JSON.stringify(out);
    write({ ok: true, output: out === undefined ? null : out, text: String(text).slice(0, 4000) });
  } catch (e) {
    write({ ok: false, error: String((e && (e.code ? `${e.code}: ` : "") + e.message) || e).slice(0, 500) });
  }
});
function write(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = JSON.stringify({ ok: false, error: "the result could not be serialised" }); }
  if (s.length > 32768) s = JSON.stringify({ ok: false, error: "the result is too large" });
  process.stdout.write(s + "\n");
}
