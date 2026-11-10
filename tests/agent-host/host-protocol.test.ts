/**
 * Phase 5: stdio agent host, protocol and host-side lifecycle.
 *   npm run build:agent-host && npm run build:agent-host-test
 *   npx tsx tests/agent-host/host-protocol.test.ts
 *
 * Every process test spawns the compiled host and talks to it over real pipes. The
 * model is scripted (see fixtures/scriptedHost.ts); the protocol, process wiring,
 * AgentRuntime, planner, verifier, tools and approval gate are the real ones.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LINE_BYTES, ProtocolError, parseRequest } from "../../agent/host/protocol";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTED = path.join(ROOT, "dist/agent-host-test/tests/agent-host/fixtures/scriptedHost.js");
const PRODUCT = path.join(ROOT, "dist/agent-host/agent/host/stdioHost.js");

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 500)}` : "")); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = Record<string, any>;
class Host {
  proc: ChildProcessWithoutNullStreams;
  lines: string[] = [];
  msgs: Msg[] = [];
  nonJson: string[] = [];
  stderr = "";
  exitCode: number | null | undefined = undefined;
  token: string;
  private buf = "";
  private n = 0;
  private waiters: (() => void)[] = [];

  constructor(entry = SCRIPTED, env: Record<string, string | undefined> = {}, token = randomBytes(32).toString("hex")) {
    this.token = token;
    this.proc = spawn(process.execPath, [entry], { env: { ...process.env, DASK_ROOT: ROOT, DASK_AGENT_HOST_TOKEN: token, ...env } as NodeJS.ProcessEnv, stdio: "pipe", windowsHide: true });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      const parts = this.buf.split("\n");
      this.buf = parts.pop() ?? "";
      for (const l of parts) {
        this.lines.push(l);
        try { this.msgs.push(JSON.parse(l)); } catch { this.nonJson.push(l); }
      }
      this.wake();
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => { this.stderr += d; });
    this.proc.on("exit", (c) => { this.exitCode = c; this.wake(); });
    this.proc.stdin.on("error", () => {});
  }
  private wake() { for (const w of this.waiters.splice(0)) w(); }
  raw(line: string) { this.proc.stdin.write(line + "\n"); }
  send(op: string, params?: unknown, id = `r${++this.n}`) { this.raw(JSON.stringify({ v: 1, id, op, ...(params === undefined ? {} : { params }) })); return id; }
  async until(pred: (m: Msg) => boolean, timeoutMs = 5_000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout waiting for message; have ${JSON.stringify(this.msgs).slice(-400)}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 200); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
  }
  reply(id: string | null, timeoutMs?: number) { return this.until((m) => m.kind === "response" && m.id === id, timeoutMs); }
  finished(taskId: string, timeoutMs?: number) { return this.until((m) => m.event === "task.finished" && m.taskId === taskId, timeoutMs); }
  async hello(extra: Msg = {}) { return this.reply(this.send("hello", { token: this.token, emergencyStopped: false, stopGeneration: 0, ...extra })); }
  async waitExit(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.exitCode === undefined && Date.now() < deadline) await sleep(20);
    return this.exitCode;
  }
  kill() { try { this.proc.kill(); } catch { /* gone */ } }
}

const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof ProtocolError ? e.code : "other"; } };

async function main(): Promise<void> {
  for (const f of [SCRIPTED, PRODUCT]) if (!fs.existsSync(f)) throw new Error(`Build first: ${f} is missing`);

  console.log("\n[A] Request validation (unit)");
  const good = { v: 1, id: "a1", op: "submit", params: { taskId: "t1", objective: "hi" } };
  check(code(() => parseRequest(JSON.stringify(good))) === null, "A1 a valid submit parses");
  check(code(() => parseRequest("{nope")) === "malformed_json", "A2 malformed JSON");
  check(code(() => parseRequest("[1,2]")) === "invalid_request", "A3 a non-object request");
  check(code(() => parseRequest(JSON.stringify({ ...good, id: "has space" }))) === "invalid_request", "A4 malformed id");
  check(code(() => parseRequest(JSON.stringify({ ...good, v: 2 }))) === "unsupported_version", "A5 unsupported version");
  check(code(() => parseRequest(JSON.stringify({ ...good, op: "runTool" }))) === "unknown_op", "A6 unknown operation");
  check(code(() => parseRequest(JSON.stringify({ ...good, op: "__proto__" }))) === "unknown_op", "A6b prototype-chain op name is not an operation");
  check(code(() => parseRequest(JSON.stringify({ ...good, extra: 1 }))) === "invalid_request", "A7 unknown top-level field");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { ...good.params, granted: ["desktop:actuate"] } }))) === "invalid_params", "A8 a smuggled grant is rejected, not ignored");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { ...good.params, approved: true } }))) === "invalid_params", "A9 a smuggled approval is rejected");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { taskId: "t1" } }))) === "invalid_params", "A10 a missing field");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { taskId: "../x", objective: "hi" } }))) === "invalid_params", "A11 an invalid taskId");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { taskId: "t", objective: "   " } }))) === "invalid_params", "A12 an empty objective");
  check(code(() => parseRequest(JSON.stringify({ ...good, params: { taskId: "t", objective: "x".repeat(4001) } }))) === "invalid_params", "A13 an oversized objective");
  check(code(() => parseRequest(JSON.stringify({ v: 1, id: "g", op: "resume", params: { generation: -1 } }))) === "invalid_params", "A14 a negative generation");

  console.log("\n[B] Authentication and framing (real process)");
  {
    const h = new Host();
    const early = await h.reply(h.send("health"));
    check(early.ok === false && early.error.code === "not_authenticated", "B1 nothing is served before hello", early);
    const sub = await h.reply(h.send("submit", { taskId: "t0", objective: "What time is it?" }));
    check(sub.error?.code === "not_authenticated", "B2 a submit before hello is refused");
    const ok = await h.hello();
    check(ok.ok === true && ok.result.protocol === 1 && ok.result.ready === true && ok.result.pid === h.proc.pid, "B3 valid hello → ready, with the host pid", ok);
    const again = await h.hello();
    check(again.error?.code === "already_authenticated", "B4 a second hello is refused");

    h.raw("this is not json");
    const bad = await h.until((m) => m.ok === false && m.error?.code === "malformed_json");
    check(bad.id === null, "B5 malformed JSON → structured error with id null; process survives");
    h.raw(JSON.stringify({ v: 1, id: "u1", op: "nonsense" }));
    check((await h.reply("u1")).error?.code === "unknown_op", "B6 unknown op → structured error with its id");
    h.raw(JSON.stringify({ v: 9, id: "u2", op: "health" }));
    check((await h.reply("u2")).error?.code === "unsupported_version", "B7 unsupported version → structured error with its id");
    h.raw(JSON.stringify({ v: 1, id: "u3", op: "submit", params: { taskId: "t", objective: 5 } }));
    check((await h.reply("u3")).error?.code === "invalid_params", "B8 invalid field → structured error with its id");
    h.raw("x".repeat(MAX_LINE_BYTES + 100));
    await h.until((m) => m.error?.code === "message_too_large");
    check((await h.reply(h.send("health"))).ok === true, "B9 an oversized line is rejected and discarded; the next request works");
    h.raw(""); h.raw("   ");
    check((await h.reply(h.send("health"))).ok === true, "B10 blank lines are ignored");

    // Partial writes and several requests in one chunk.
    const j = (id: string) => JSON.stringify({ v: 1, id, op: "health" });
    h.proc.stdin.write(j("c1").slice(0, 10));
    await sleep(30);
    h.proc.stdin.write(j("c1").slice(10) + "\n" + j("c2") + "\r\n" + j("c3") + "\n");
    check((await h.reply("c1")).ok && (await h.reply("c2")).ok && (await h.reply("c3")).ok, "B11 framing: split writes, CRLF, and several lines in one chunk");

    const ids = Array.from({ length: 200 }, (_, i) => `seq${i}`);
    for (const id of ids) h.send("health", undefined, id);
    await h.reply("seq199");
    const got = h.msgs.filter((m) => m.kind === "response" && String(m.id).startsWith("seq")).map((m) => m.id);
    check(JSON.stringify(got) === JSON.stringify(ids), "B12 200 sequential requests: one response each, correct ids, in order");
    check(h.nonJson.length === 0, "B13 every stdout line so far is valid JSON", h.nonJson);
    h.kill();

    const w = new Host();
    const rej = await w.reply(w.send("hello", { token: "wrong-token-wrong-token-wrong-token", emergencyStopped: false, stopGeneration: 0 }));
    check(rej.error?.code === "authentication_failed", "B14 wrong token → refused");
    check(await w.waitExit() === 3, "B15 …and the host exits (no retries)", w.exitCode);
    check(!w.stderr.includes("wrong-token"), "B16 the presented token is not logged");

    const none = new Host(SCRIPTED, { DASK_AGENT_HOST_TOKEN: "short" });
    check(await none.waitExit() === 2, "B17 a host without a valid token refuses to start", none.exitCode);
  }

  console.log("\n[C] Tasks: correlation, real outcomes, concurrency");
  {
    const h = new Host();
    await h.hello();
    const id1 = h.send("submit", { taskId: "t1", objective: "What time is it?" });
    const ack = await h.reply(id1);
    check(ack.ok && ack.result.accepted === true && ack.result.taskId === "t1", "C1 submit is acknowledged immediately with its request id", ack);
    const fin = await h.finished("t1");
    check(fin.requestId === id1, "C2 task.finished carries the submit's request id");
    check(fin.data.outcome === "completed" && fin.data.verification.independentlyVerified === true && fin.data.steps[0].tool === "system.time", "C3 real runtime path: tool ran, independently verified, completed", fin.data);
    const seqs = h.msgs.filter((m) => m.kind === "event" && m.taskId === "t1").map((m) => m.seq);
    check(seqs.length > 1 && seqs.every((s, i) => s === i + 1), "C4 events are numbered without gaps", seqs);
    check(h.msgs.some((m) => m.event === "task.progress" && m.taskId === "t1" && m.data.type === "step.finished"), "C5 progress events are streamed");
    const st = await h.reply(h.send("status", { taskId: "t1" }));
    check(st.result.state === "finished" && st.result.result.outcome === "completed", "C6 status reports the finished result");
    check((await h.reply(h.send("status", { taskId: "nope" }))).error?.code === "unknown_task", "C7 status of an unknown task");
    check((await h.reply(h.send("cancel", { taskId: "nope" }))).error?.code === "unknown_task", "C8 cancel of an unknown task");
    check((await h.reply(h.send("submit", { taskId: "t1", objective: "What time is it?" }))).error?.code === "duplicate_task", "C9 a resubmitted task id is refused, never run twice");

    // The host must report the runtime's actual outcome, not convert it.
    await h.reply(h.send("submit", { taskId: "t2", objective: "Do the thing we discussed about the time" }));
    const unv = await h.finished("t2");
    check(unv.data.outcome === "unverified", "C10 model says satisfied, but the request is not fully explained → unverified is reported as unverified", unv.data.outcome);
    await h.reply(h.send("submit", { taskId: "t3", objective: "calc 1/0" }));
    const failedRun = await h.finished("t3");
    check(failedRun.data.outcome === "failed" && failedRun.data.steps[0].status === "failed", "C11 a failing tool → failed is reported as failed", failedRun.data);
    await h.reply(h.send("submit", { taskId: "t4", objective: "What is (17+25)*2?" }));
    const wrong = await h.finished("t4");
    check(wrong.data.outcome === "failed" && wrong.data.toolCalls === 0 && /not taken from the request/.test(wrong.data.error ?? ""), "C12 a changed expression is rejected before execution through the host", wrong.data);

    const s1 = h.send("submit", { taskId: "t5", objective: "slowtool" });
    await h.reply(s1);
    const busy = await h.reply(h.send("submit", { taskId: "t6", objective: "What time is it?" }));
    check(busy.error?.code === "busy", "C13 a concurrent submit gets busy, explicitly, and is not queued");
    const hl = await h.reply(h.send("health"));
    check(hl.result.activeTaskId === "t5", "C14 other requests are served while a task runs", hl.result);
    await h.reply(h.send("cancel", { taskId: "t5" }));
    await h.finished("t5");
    await h.reply(h.send("submit", { taskId: "t6", objective: "What time is it?" }));
    check((await h.finished("t6")).data.outcome === "completed", "C15 t6 was refused earlier, so its id is still usable afterwards");
    check(h.nonJson.length === 0, "C16 all stdout valid JSON");
    h.kill();
  }

  console.log("\n[D] Stdout isolation");
  {
    const h = new Host();
    await h.hello();
    await h.reply(h.send("submit", { taskId: "n1", objective: "noisy" }));
    const fin = await h.finished("n1");
    await sleep(50);
    check(fin.data.steps[0].status === "succeeded" && h.nonJson.length === 0, "D1 a tool writing to stdout/console cannot corrupt the protocol", h.nonJson);
    check(h.stderr.includes("NOISE from console.log") && h.stderr.includes("NOISE from stdout.write"), "D2 that output goes to stderr");
    await h.reply(h.send("submit", { taskId: "n2", objective: "newline" }));
    const nl = await h.finished("n2");
    check(nl.data.steps[0].evidence.includes("line two") && h.nonJson.length === 0, "D3 newlines in tool output stay inside one JSON line");
    check(!h.msgs.some((m) => m.id === "forged"), "D4 JSON-looking tool output cannot forge a protocol response");
    await h.reply(h.send("submit", { taskId: "n3", objective: "secret objective text envcheck" }));
    const env = await h.finished("n3");
    check(env.data.steps[0].evidence === "token=absent cloud=absent", "D5 tools see neither the host token nor cloud keys", env.data.steps[0].evidence);
    check(!h.stderr.includes(h.token), "D6 the token is never logged");
    check(!h.stderr.includes("secret objective text"), "D7 objectives are not logged");
    h.kill();
  }
  {
    const h = new Host(SCRIPTED, { GROQ_API_KEY: "gsk_should_be_scrubbed" });
    await h.hello();
    await h.reply(h.send("submit", { taskId: "n4", objective: "envcheck" }));
    check((await h.finished("n4")).data.steps[0].evidence.endsWith("cloud=absent"), "D8 inherited cloud keys are scrubbed before any tool runs");
    h.kill();
  }

  console.log("\n[E] Cancellation, Emergency Stop, approvals");
  {
    const h = new Host();
    await h.hello();
    for (const [id, objective, label] of [["k1", "slowmodel", "inference"], ["k2", "slowtool", "tool execution"]] as const) {
      await h.reply(h.send("submit", { taskId: id, objective }));
      await sleep(150);
      const t0 = Date.now();
      const c = await h.reply(h.send("cancel", { taskId: id }));
      const fin = await h.finished(id);
      const ms = Date.now() - t0;
      check(c.result.cancelling === true && fin.data.outcome === "cancelled" && ms < 500, `E1 cancel during ${label} → cancelled in under 500 ms`, { ms, outcome: fin.data.outcome });
      console.log(`  MEASURED cancel during ${label}: ${ms} ms (scripted model)`);
    }
    const c2 = await h.reply(h.send("cancel", { taskId: "k1" }));
    check(c2.result.cancelling === false && c2.result.state === "finished", "E2 cancelling a finished task changes nothing");

    await h.reply(h.send("submit", { taskId: "e1", objective: "slowtool" }));
    await sleep(100);
    const t0 = Date.now();
    const stop = await h.reply(h.send("emergency_stop", { generation: 7 }));
    const finE = await h.finished("e1");
    const stopMs = Date.now() - t0;
    check(stop.result.stopped === true && stop.result.abortedTasks[0] === "e1" && stop.result.generation === 7, "E3 Emergency Stop acknowledges and names the aborted task", stop.result);
    check(finE.data.outcome === "cancelled" && stopMs < 500, "E4 the running task aborts within 500 ms", { stopMs });
    console.log(`  MEASURED Emergency Stop to task end: ${stopMs} ms`);
    check((await h.reply(h.send("submit", { taskId: "e2", objective: "What time is it?" }))).error?.code === "emergency_stopped", "E5 new tasks are refused while stopped");
    check((await h.reply(h.send("resume", { generation: 6 }))).error?.code === "stale_generation", "E6 a stale resume is rejected");
    check((await h.reply(h.send("submit", { taskId: "e3", objective: "What time is it?" }))).error?.code === "emergency_stopped", "E7 …and the host stays stopped");
    check((await h.reply(h.send("resume", { generation: 7 }))).result.stopped === false, "E8 resume with the current generation");
    await h.reply(h.send("submit", { taskId: "e2", objective: "What time is it?" }));
    check((await h.finished("e2")).data.outcome === "completed", "E9 tasks run again after resume");
    h.kill();

    const s = new Host();
    const he = await s.hello({ emergencyStopped: true, stopGeneration: 12 });
    check(he.result.emergencyStopped === true && he.result.stopGeneration === 12, "E10 a host started during a stop starts stopped");
    check((await s.reply(s.send("submit", { taskId: "x", objective: "What time is it?" }))).error?.code === "emergency_stopped", "E11 …a restart cannot clear a stop");
    s.kill();

    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dask-host-")), "marker.txt");
    const a = new Host(SCRIPTED, { DASK_TEST_MARKER_FILE: marker });
    await a.hello();
    await a.reply(a.send("submit", { taskId: "a1", objective: "approval" }));
    const finA = await a.finished("a1");
    check(finA.data.outcome === "failed" && /Approval denied/.test(finA.data.steps[0].error ?? "") && !fs.existsSync(marker), "E12 an approval-required tool never runs: the host has no way to grant approval", finA.data);
    check(a.msgs.some((m) => m.data?.type === "approval.denied"), "E13 the denial is reported");
    a.kill();
  }

  console.log("\n[F] Shutdown");
  {
    const h = new Host();
    await h.hello();
    await h.reply(h.send("submit", { taskId: "z1", objective: "slowtool" }));
    await sleep(100);
    const sd = await h.reply(h.send("shutdown"));
    const fin = await h.finished("z1");
    const ec = await h.waitExit();
    check(sd.result.shuttingDown === true && fin.data.outcome === "cancelled" && ec === 0, "F1 shutdown during a task: acknowledged, task reports cancelled, exit 0", { ec });

    const eof = new Host();
    await eof.hello();
    await eof.reply(eof.send("submit", { taskId: "z2", objective: "slowmodel" }));
    await sleep(100);
    eof.proc.stdin.end();
    check(await eof.waitExit() === 0, "F2 stdin closed (owner gone) → the host exits instead of lingering", eof.exitCode);

    const crash = new Host();
    await crash.hello();
    await crash.reply(crash.send("submit", { taskId: "z3", objective: "crash" }));
    check(await crash.waitExit() === 77, "F3 a crash is a real process exit (the owner detects it), not a swallowed error", crash.exitCode);
  }

  console.log("\n[G] Product entry point");
  {
    const cloud = new Host(PRODUCT, { DASK_INFERENCE: "cloud" });
    check(await cloud.waitExit() === 2 && /must be local/.test(cloud.stderr), "G1 the product host refuses DASK_INFERENCE=cloud", cloud.stderr);
    const noRoot = new Host(PRODUCT, { DASK_ROOT: "" });
    check(await noRoot.waitExit() === 2, "G2 the product host refuses to start without DASK_ROOT");

    const h = new Host(PRODUCT, { DASK_INFERENCE: undefined, GROQ_API_KEY: "gsk_x", OPENROUTER_API_KEY: "sk_x" });
    const ok = await h.hello();
    check(ok.ok && ok.result.model.state === "unavailable", "G3 product host ready without loading a model (lazy load)", ok.result);
    await h.reply(h.send("shutdown"));
    check(await h.waitExit() === 0, "G4 product host shuts down cleanly");

    // Static guarantee about what the compiled product host can reach.
    const dist = path.join(ROOT, "dist/agent-host");
    const js: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".js")) js.push(p); } };
    walk(dist);
    const text = js.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    check(!/require\("(openai|@google\/genai|groq-sdk)"\)|modelRouter|cloudModel|taskService/.test(text), "G5 no cloud SDK, cloud router or Next-side service in the product host's compiled code");
    check(!/scripted|test\.slow/i.test(text), "G6 no test model in the product host's compiled code");
    check(!/createServer\(|\.listen\(/.test(fs.readFileSync(path.join(dist, "agent/host/host.js"), "utf8") + fs.readFileSync(path.join(dist, "agent/host/stdio.js"), "utf8") + fs.readFileSync(path.join(dist, "agent/host/stdioHost.js"), "utf8")), "G7 the host opens no network listener");
    check(!/child_process|execSync|spawn\(/.test(fs.readFileSync(path.join(dist, "agent/host/host.js"), "utf8")), "G8 the protocol layer has no way to spawn anything");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
