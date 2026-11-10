/**
 * Phase 5 measurements. Writes research/benchmark/results/p5_stack.json. Everything is measured here.
 *
 *   npx tsx research/benchmark/phase5-stack.ts [--hud <path to hud-native.exe>] [--no-tiers]
 *
 * Part H: host alone (product entry point over real pipes): start, readiness, round trip, memory.
 * Part S: complete desktop stack: real daemon, real HUD with its WebView, real host, real llama-server.
 * Part T: experimental model tiers: real model switches driven by the unchanged memory guard. To change
 *         what the guard sees WITHOUT touching it or any other application, a ballast child process of
 *         this script holds memory and later exits.
 *
 * Starts and stops only its own processes. The HUD allowlist entry is set through environment variables
 * for this run only; no configuration file changes.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const HUD = path.resolve(arg("hud") ?? path.join(ROOT, "src/hud-native/target/h3-verify/debug/hud-native.exe"));
const DAEMON = path.join(ROOT, "src/DAsk.Daemon/bin/Debug/net8.0/DAsk.Daemon.exe");
const HOST = path.join(ROOT, "dist/agent-host/agent/host/stdioHost.js");
const PIPE = "d-ask-ipc-v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;
const out: Record<string, any> = { at: new Date().toISOString(), machine: { cpu: os.cpus()[0]?.model.trim(), totalMB: Math.round(os.totalmem() / MiB) } };
const log = (s: string) => console.log(`[stack] ${s}`);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

// ── Memory sampling (one PowerShell call per sample) ─────────────────────────
interface Snapshot { availMB: number; daemonMB: number; hudMB: number; webviewMB: number; hostMB: number; llamaMB: number; llamaCount: number; llamaIds: number[]; hostPid: number | null }
function sample(daemonPid: number | null, hudPid: number | null): Snapshot {
  const script = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine
$kids = @{}; foreach ($p in $all) { if (-not $kids.ContainsKey([int]$p.ParentProcessId)) { $kids[[int]$p.ParentProcessId] = @() }; $kids[[int]$p.ParentProcessId] += $p }
function Tree($id) { $r=@(); foreach ($c in $kids[[int]$id]) { $r += $c; $r += Tree $c.ProcessId }; return $r }
$web = 0; if (${hudPid ?? 0}) { foreach ($c in (Tree ${hudPid ?? 0})) { if ($c.Name -like 'msedgewebview2*') { $web += $c.WorkingSetSize } } }
$hud = ($all | Where-Object ProcessId -eq ${hudPid ?? 0}).WorkingSetSize
$dm = ($all | Where-Object ProcessId -eq ${daemonPid ?? 0}).WorkingSetSize
$host_ = $all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'stdioHost' } | Select-Object -First 1
$ll = @($all | Where-Object Name -eq 'llama-server.exe')
$llMem = ($ll | Measure-Object WorkingSetSize -Sum).Sum
$av = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
"$av|$dm|$hud|$web|$($host_.WorkingSetSize)|$llMem|$($ll.Count)|$(($ll.ProcessId) -join ',')|$($host_.ProcessId)"`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const p = (r.stdout ?? "").trim().split("|");
  const m = (v: string) => Math.round(Number(v || 0) / MiB);
  return {
    availMB: Math.round(Number(p[0] || 0) / 1024), daemonMB: m(p[1]), hudMB: m(p[2]), webviewMB: m(p[3]), hostMB: m(p[4]), llamaMB: m(p[5]),
    llamaCount: Number(p[6] || 0), llamaIds: (p[7] || "").split(",").filter(Boolean).map(Number), hostPid: p[8] ? Number(p[8]) : null,
  };
}
const total = (s: Snapshot) => s.daemonMB + s.hudMB + s.webviewMB + s.hostMB + s.llamaMB;

// ── Part H: host alone ───────────────────────────────────────────────────────
async function partHost(): Promise<void> {
  log("Part H: host alone");
  const starts: number[] = [];
  let rtts: number[] = [];
  let rss = 0;
  for (let i = 0; i < 5; i++) {
    const token = randomBytes(32).toString("hex");
    const t0 = performance.now();
    const p = spawn(process.execPath, [HOST], { env: { ...process.env, DASK_ROOT: ROOT, DASK_AGENT_HOST_TOKEN: token, DASK_INFERENCE: "local" }, stdio: "pipe", windowsHide: true });
    let buf = "";
    const waiters = new Map<string, (m: any) => void>();
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      buf += d; const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) { const m = JSON.parse(l); waiters.get(m.id)?.(m); waiters.delete(m.id); }
    });
    const req = (id: string, op: string, params: unknown = {}) => new Promise<any>((res) => { waiters.set(id, res); p.stdin.write(JSON.stringify({ v: 1, id, op, params }) + "\n"); });
    await req("h", "hello", { token, emergencyStopped: false, stopGeneration: 0 });
    starts.push(performance.now() - t0);
    if (i === 4) {
      rtts = [];
      for (let k = 0; k < 500; k++) { const t = performance.now(); await req(`p${k}`, "health"); rtts.push(performance.now() - t); }
      rss = (await req("r", "health")).result.rssMB;
    }
    await req("s", "shutdown");
    await new Promise((r) => p.once("exit", r));
  }
  out.host = {
    startToReadyMs: { samples: starts.map((x) => Math.round(x)), median: Math.round(pct(starts, 50)) },
    requestRoundTripMs: { n: rtts.length, p50: +pct(rtts, 50).toFixed(2), p95: +pct(rtts, 95).toFixed(2), p99: +pct(rtts, 99).toFixed(2), max: +Math.max(...rtts).toFixed(2) },
    idleRssMB: rss,
  };
  log(JSON.stringify(out.host));
}

// ── Named-pipe client (the daemon's real protocol) ───────────────────────────
class PipeClient {
  sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private listeners: ((e: any) => void)[] = [];
  connect(): Promise<void> {
    return new Promise((res, rej) => { this.sock = net.connect(`\\\\.\\pipe\\${PIPE}`, () => res()); this.sock.once("error", rej); this.sock.on("data", (d) => this.feed(d)); });
  }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) return;
      const e = JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8"));
      this.buf = this.buf.subarray(4 + n);
      for (const l of [...this.listeners]) l(e);
    }
  }
  send(type: string, payload: unknown) {
    const id = randomUUID().replace(/-/g, "");
    const body = Buffer.from(JSON.stringify({ version: PROTOCOL, id, type, timestamp: new Date().toISOString(), payload }));
    const h = Buffer.alloc(4); h.writeUInt32LE(body.length);
    this.sock.write(Buffer.concat([h, body]));
    return id;
  }
  until(pred: (e: any) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); rej(new Error("pipe timeout")); }, timeoutMs);
      const l = (e: any) => { if (pred(e)) { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== l); res(e); } };
      this.listeners.push(l);
    });
  }
  async request(type: string, payload: unknown, timeoutMs = 60_000) {
    const wait = (id: string) => this.until((e) => e.replyToId === id, timeoutMs);
    const id = this.send(type, payload);
    return (await wait(id)).payload;
  }
  /** Submits and waits for the result, sampling memory while the task runs. */
  async task(objective: string, onSample: () => void, timeoutMs = 240_000): Promise<{ ms: number; result: any }> {
    const t0 = performance.now();
    const ack = await this.request("AgentTaskSubmitRequest", { objective }, 60_000);
    if (!ack.accepted) throw new Error(`refused: ${ack.rejectionCode} ${ack.errorMessage}`);
    const done = this.until((e) => e.type === "AgentTaskResultNotification" && e.payload.taskId === ack.taskId, timeoutMs);
    let finished = false;
    void done.finally(() => { finished = true; });
    while (!finished) { onSample(); await Promise.race([done, sleep(400)]).catch(() => {}); }
    return { ms: Math.round(performance.now() - t0), result: (await done).payload };
  }
}
let PROTOCOL = 1;

function startDaemon(extraEnv: Record<string, string>): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, DASK_Daemon__AllowedClientImagePaths__0: HUD, DASK_Daemon__AllowedClientImagePaths__1: process.execPath, ...extraEnv };
  const p = spawn(DAEMON, [], { cwd: path.dirname(DAEMON), env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  return p;
}

async function connectPipe(): Promise<PipeClient> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const c = new PipeClient();
    try {
      await c.connect();
      const id = c.send("HandshakeRequest", { clientName: "phase5-stack", protocolVersion: PROTOCOL, clientProcessId: process.pid, capabilities: ["agent"] });
      const r = (await c.until((e) => e.replyToId === id, 8_000)).payload;
      if (r.status !== "Accepted") throw new Error(`handshake ${r.status}: ${r.message}`);
      return c;
    } catch (e) {
      try { c.sock?.destroy(); } catch { /* */ }
      if (Date.now() > deadline) throw e;
      await sleep(500);
    }
  }
}

// ── Part S: complete stack ───────────────────────────────────────────────────
const killTree = (pid: number | undefined) => { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); };

async function partStack(): Promise<void> {
  log("Part S: complete desktop stack");
  const s0 = sample(null, null);
  const daemon = startDaemon({ DASK_LOCAL_IDLE_MS: "0" });
  await sleep(4_000);
  let hud: ChildProcess | null = null;
  const hudPresent = fs.existsSync(HUD);
  if (hudPresent) hud = spawn(HUD, [], { cwd: path.dirname(HUD), stdio: "ignore", windowsHide: false });
  await sleep(20_000); // daemon connection, WebView2 start and first paint
  const pipe = await connectPipe();
  const s1 = sample(daemon.pid!, hud?.pid ?? null);
  log(`daemon + HUD idle: ${JSON.stringify(s1)}`);
  const hudAlive = !!hud && hud.exitCode === null;

  const during: Snapshot[] = [];
  const take = () => { during.push(sample(daemon.pid!, hud?.pid ?? null)); };
  const tasks: Record<string, unknown>[] = [];
  for (const objective of ["What is (17+25)*2?", "What time is it?", "How much memory does this computer have?", "What time is it in Tokyo, and what is in agent/runtime?", "What is 144/12 + 7*3?"]) {
    const r = await pipe.task(objective, take);
    tasks.push({ objective, ms: r.ms, outcome: r.result.outcome, response: String(r.result.response).slice(0, 160) });
    log(`${r.result.outcome} ${r.ms} ms: ${objective}`);
  }
  const s2 = sample(daemon.pid!, hud?.pid ?? null);
  const minAvail = Math.min(...during.map((d) => d.availMB), s2.availMB);
  const peakTotal = Math.max(...during.map(total), total(s2));
  const health = await pipe.request("AgentHostHealthRequest", {});
  out.stack = {
    hud: hudPresent ? (hudAlive ? { path: path.relative(ROOT, HUD), running: true, connectedToDaemon: "see the daemon log; HUD peer check is mutual" } : { path: path.relative(ROOT, HUD), running: false }) : { running: false, reason: "binary not found" },
    model: health.modelId,
    availableMB: { beforeStack: s0.availMB, daemonAndHudIdle: s1.availMB, lowestDuringTasks: minAvail },
    workingSetMB: { daemon: s2.daemonMB, hud: s2.hudMB, webview2: s2.webviewMB, agentHost: s2.hostMB, llamaServer: s2.llamaMB, total: total(s2), peakTotal },
    samples: during.length,
    maxLlamaServers: Math.max(...during.map((d) => d.llamaCount)),
    tasks,
    oneGbFreeTarget: minAvail >= 1024 ? "met" : "NOT met",
  };
  log(JSON.stringify(out.stack));
  pipe.sock.destroy();
  killTree(hud?.pid);
  killTree(daemon.pid);
  await sleep(2_000);
  out.stack.afterShutdown = (() => { const s = sample(null, null); return { llamaServers: s.llamaCount, hostRunning: s.hostPid !== null, availMB: s.availMB }; })();
}

// ── Part T: experimental model tiers, real switches ──────────────────────────
function startBallast(mb: number): Promise<ChildProcess> {
  const code = `const b=[];for(let i=0;i<${Math.ceil(mb / 256)};i++){const x=Buffer.alloc(256*1024*1024);for(let j=0;j<x.length;j+=4096)x[j]=1;b.push(x)}process.stdout.write("held\\n");setInterval(()=>{for(const x of b)for(let j=0;j<x.length;j+=1048576)x[j]^=1},2000)`;
  return new Promise((res) => {
    const p = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    p.stdout!.once("data", () => res(p));
  });
}

async function partTiers(): Promise<void> {
  log("Part T: model tiers");
  const IDLE = 2_000;
  const daemon = startDaemon({ DASK_AgentHost__ExperimentalModelTiers: "true", DASK_LOCAL_IDLE_MS: String(IDLE) });
  await sleep(4_000);
  const pipe = await connectPipe();
  let maxLlama = 0;
  const watch = () => { const s = sample(daemon.pid!, null); maxLlama = Math.max(maxLlama, s.llamaCount); return s; };
  const steps: Record<string, unknown>[] = [];

  async function step(label: string, target: "fallback" | "preferred") {
    const before = watch();
    let ballast: ChildProcess | null = null;
    // 3B's guard requirement is about 4.6 GB free; 0.5B's about 3.0 GB. Aim between them for "fallback".
    if (target === "fallback" && before.availMB > 4_200) {
      ballast = await startBallast(before.availMB - 3_800);
      await sleep(500);
    }
    const atDecision = watch();
    const during: Snapshot[] = [];
    let r: { ms: number; result: any };
    try {
      r = await pipe.task("What is 6*7?", () => { const s = watch(); during.push(s); });
    } catch (e) {
      steps.push({ label, target, error: String(e), availAtDecision: atDecision.availMB });
      ballast?.kill();
      return;
    }
    const health = await pipe.request("AgentHostHealthRequest", {});
    const peak = during.length ? Math.max(...during.map((d) => d.llamaMB)) : 0;
    ballast?.kill();
    await sleep(IDLE + 3_000); // idle unload, then memory returns
    const after = watch();
    steps.push({ label, target, availBeforeMB: before.availMB, availAtDecisionMB: atDecision.availMB, availLowestDuringMB: during.length ? Math.min(...during.map((d) => d.availMB)) : null, llamaPeakMB: peak, availAfterUnloadMB: after.availMB, llamaAfterUnload: after.llamaCount, modelId: health.modelId, firstTaskMs: r.ms, outcome: r.result.outcome });
    log(JSON.stringify(steps.at(-1)));
  }

  await step("start low: expect 0.5B", "fallback");
  await step("memory free: expect 3B if admitted", "preferred");
  await step("low again: expect 0.5B", "fallback");
  out.tiers = { steps, maxConcurrentLlamaServers: maxLlama };
  pipe.sock.destroy();
  killTree(daemon.pid);
  await sleep(1_500);
  out.tiers.afterShutdownLlamaServers = sample(null, null).llamaCount;
}

async function main(): Promise<void> {
  const ipc = fs.readFileSync(path.join(ROOT, "src/DAsk.Protocol/IPC/IpcConstants.cs"), "utf8");
  PROTOCOL = Number(/CurrentProtocolVersion\s*=\s*(\d+)/.exec(ipc)?.[1] ?? 1);
  if (sample(null, null).llamaCount > 0) throw new Error("llama-server is already running; refusing to measure");
  await partHost();
  await partStack();
  if (!process.argv.includes("--no-tiers")) await partTiers();
  fs.writeFileSync(path.join(__dirname, "results", "p5_stack.json"), JSON.stringify(out, null, 2));
  log("wrote results/p5_stack.json");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); fs.writeFileSync(path.join(__dirname, "results", "p5_stack_partial.json"), JSON.stringify({ ...out, error: String(e) }, null, 2)); process.exit(1); });
