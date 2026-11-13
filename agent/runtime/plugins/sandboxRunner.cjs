// Plugin sandbox runner: executed as `node --permission --allow-fs-read=<sealed copy> --allow-fs-read=<this folder>
// --disallow-code-generation-from-strings --max-old-space-size=96 --require sandboxPreload.cjs sandboxRunner.cjs`.
//
// Protocol (one line = one JSON object, both directions):
//   host -> runner, FIRST line:  {"entry": "<file in the sealed copy>", "tool": "<export name>", "input": {...}}
//   runner -> host, any number:  {"cap": "files.read" | "memory.read", "id": <n>, "args": {...}}     (a REQUEST; the host decides)
//   host -> runner, one per request: {"id": <n>, "ok": true, "value": ...} | {"id": <n>, "ok": false, "code": "...", "error": "..."}
//   runner -> host, LAST line:   {"ok":true,"output":…,"text":"…"} or {"ok":false,"error":"…"}
//
// The sandbox itself grants nothing beyond computation. The global `dask` object only SENDS requests; the agent host re-reads the
// user's current grants for every request and refuses (with a clear message) what the plugin does not have. Nothing in this file
// can allow a capability: all it can do is ask.
"use strict";
const path = require("node:path");

let buf = "";
let started = false;
let nextId = 1;
const pending = new Map();

function writeLine(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = JSON.stringify({ ok: false, error: "the result could not be serialised" }); }
  if (s.length > 32768) s = JSON.stringify({ ok: false, error: "the result is too large" });
  process.stdout.write(s + "\n");
}

function request(cap, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    writeLine({ cap, id, args });
  });
}

const dask = Object.freeze({
  /** Reads a text file the user allowed D-ASK to read. Needs the files.read permission. */
  readFile: (p) => request("files.read", { path: String(p) }),
  /** Searches the notes the user asked D-ASK to remember. Needs the memory.read permission. */
  searchMemory: (q) => request("memory.read", { query: String(q) }),
});
Object.defineProperty(globalThis, "dask", { value: dask, writable: false, configurable: false, enumerable: false });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.length > 200000) { writeLine({ ok: false, error: "request too large" }); process.exit(2); }
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    if (!started) { started = true; void run(line); continue; }
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const p = pending.get(r && r.id);
    if (!p) continue;
    pending.delete(r.id);
    if (r.ok === true) p.resolve(r.value);
    else { const e = new Error(String(r.error || "denied")); e.code = String(r.code || "ERR_PLUGIN_DENIED"); p.reject(e); }
  }
});
process.stdin.on("end", () => { for (const p of pending.values()) { const e = new Error("the host closed the connection"); e.code = "ERR_PLUGIN_HOST_CLOSED"; p.reject(e); } pending.clear(); });

async function run(line) {
  let req;
  try { req = JSON.parse(line); } catch { writeLine({ ok: false, error: "malformed request" }); finish(); return; }
  try {
    const mod = require(path.resolve(req.entry));
    const fn = mod && mod[req.tool];
    if (typeof fn !== "function") { writeLine({ ok: false, error: `the plugin does not export ${req.tool}` }); finish(); return; }
    const out = await fn(req.input);
    const text = out && typeof out.text === "string" ? out.text : JSON.stringify(out);
    writeLine({ ok: true, output: out === undefined ? null : out, text: String(text).slice(0, 4000) });
  } catch (e) {
    writeLine({ ok: false, error: String((e && (e.code ? `${e.code}: ` : "") + e.message) || e).slice(0, 500) });
  }
  finish();
}

/** Ends the process the way the old one-shot runner did: stop reading stdin, let the event loop drain (no process.exit, which can cut a pipe write short on Windows). */
function finish() { process.stdin.destroy(); }
