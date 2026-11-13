// ─────────────────────────────────────────────────────────────────────────────
// InferenceSupervisor — owns the single llama-server process for agent inference.
//
// Lifecycle:  unavailable ──acquire──▶ loading ──▶ ready | degraded
//                  ▲                     │  ▲            │
//                  └── stop / idle ──────┘  └─ crash (bounded restarts, backoff)
//                                        └──▶ failed  (verification, memory,
//                                                      auth not enforced, or
//                                                      restarts exhausted)
//
//   ready     serving on the preferred backend
//   degraded  serving, but on the CPU fallback after the Vulkan launch failed
//
// Before every launch: SHA-256 of every pinned runtime file and of the model,
// then memory admission (memory.ts). The server listens on 127.0.0.1 on a random
// port, with a fresh random API key passed through the environment (never on the
// command line, never logged). Startup is not complete until the server proves
// it rejects requests without the key.
//
// Nothing is ever downloaded here. The environment passed to llama-server is
// stripped of LLAMA_*/HF_* variables and the server runs with --offline.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { EndpointProvider, LocalEndpoint } from "./llamaServerModel";
import { LocalInferenceError } from "./llamaServerModel";
import { PINNED_MANIFEST, findModel, verifyModel, verifyRuntime, type ArtifactManifest, type ModelArtifact } from "./manifest";
import { admitModel, estimateModelMemory, osMemoryProbe, DEFAULT_MIN_HEADROOM_MB, type MemoryAdmission, type MemoryEstimate, type MemoryProbe } from "./memory";

export type SupervisorState = "unavailable" | "loading" | "ready" | "degraded" | "failed";
export type Backend = "vulkan" | "cpu";

export interface SupervisorStatus {
  state: SupervisorState;
  modelId: string;
  backend: Backend | null;
  preferredBackend: "auto" | Backend;
  fallbackReason: string | null;
  pid: number | null;
  port: number | null;
  restarts: number;
  inFlight: number;
  lastError: string | null;
  memoryEstimate: MemoryEstimate;
  lastAdmission: MemoryAdmission | null;
  readyAt: number | null;
}

export type Launcher = (file: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

export interface SupervisorOptions {
  /** Directory the manifest's relative paths resolve against. Default: DASK_ROOT or cwd. */
  root?: string;
  manifest?: ArtifactManifest;
  modelId?: string;
  contextSize?: number;
  threads?: number;
  backend?: "auto" | Backend;
  gpuLayers?: number;
  /** Stop the server after this long with no requests. 0 = never. */
  idleUnloadMs?: number;
  readyTimeoutMs?: number;
  maxRestarts?: number;
  restartBackoffMs?: number;
  /** A server that stays up this long resets the restart counter. */
  stableResetMs?: number;
  minHeadroomMB?: number;
  memoryProbe?: MemoryProbe;
  /** Test seam: how the process is started. Hash verification still applies to the manifest's files. */
  launcher?: Launcher;
  onStatus?: (status: SupervisorStatus) => void;
}

/** Errors that retrying cannot fix. */
export class SupervisorFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorFatalError";
  }
}

class StartCancelled extends Error {
  constructor() { super("start cancelled"); }
}

interface Instance {
  child: ChildProcess;
  backend: Backend;
  port: number;
  baseUrl: string;
  /** Aborted when this instance stops or dies; in-flight requests observe it. */
  life: AbortController;
  exited: Promise<void>;
  hasExited: boolean;
}

const LOG_LINES = 200;
// Referenced timer on purpose: startup polling and restart backoff must keep the
// host alive until they finish (only the idle/stable timers are unref'd).
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class InferenceSupervisor {
  readonly #root: string;
  readonly #manifest: ArtifactManifest;
  readonly #model: ModelArtifact;
  readonly #opts: Required<Omit<SupervisorOptions, "root" | "manifest" | "modelId" | "launcher" | "onStatus" | "memoryProbe">>;
  readonly #probe: MemoryProbe;
  readonly #launcher: Launcher;
  readonly #onStatus?: (s: SupervisorStatus) => void;
  readonly #estimate: MemoryEstimate;

  #state: SupervisorState = "unavailable";
  #instance: Instance | null = null;
  #apiKey: string | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #backend: Backend;
  #fallbackReason: string | null = null;
  #restarts = 0;
  #inFlight = 0;
  #lastError: string | null = null;
  #lastAdmission: MemoryAdmission | null = null;
  #readyAt: number | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;
  #log: string[] = [];
  #exitHook: (() => void) | null = null;
  #orphanCheckDone = false;
  #startAbort: AbortController | null = null;

  constructor(opts: SupervisorOptions = {}) {
    this.#root = path.resolve(opts.root ?? process.env.DASK_ROOT ?? process.cwd());
    this.#manifest = opts.manifest ?? PINNED_MANIFEST;
    this.#model = findModel(this.#manifest, opts.modelId ?? this.#manifest.models[0].id);
    this.#opts = {
      contextSize: opts.contextSize ?? this.#model.defaultContext,
      threads: opts.threads ?? Math.max(2, Math.min(8, os.availableParallelism() - 2)),
      backend: opts.backend ?? "auto",
      gpuLayers: opts.gpuLayers ?? 999,
      idleUnloadMs: opts.idleUnloadMs ?? 300_000,
      readyTimeoutMs: opts.readyTimeoutMs ?? 120_000,
      maxRestarts: opts.maxRestarts ?? 3,
      restartBackoffMs: opts.restartBackoffMs ?? 1_000,
      stableResetMs: opts.stableResetMs ?? 60_000,
      minHeadroomMB: opts.minHeadroomMB ?? DEFAULT_MIN_HEADROOM_MB,
    };
    if (!(this.#opts.minHeadroomMB >= DEFAULT_MIN_HEADROOM_MB)) {
      throw new SupervisorFatalError(`minHeadroomMB may not be lowered below the daemon's ${DEFAULT_MIN_HEADROOM_MB} MB`);
    }
    this.#probe = opts.memoryProbe ?? osMemoryProbe;
    this.#launcher = opts.launcher ?? defaultLauncher;
    this.#onStatus = opts.onStatus;
    this.#backend = this.#opts.backend === "cpu" ? "cpu" : "vulkan";
    this.#estimate = estimateModelMemory(this.#model, this.#opts.contextSize);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  status(): SupervisorStatus {
    return {
      state: this.#state,
      modelId: this.#model.id,
      backend: this.#instance ? this.#instance.backend : null,
      preferredBackend: this.#opts.backend,
      fallbackReason: this.#fallbackReason,
      pid: this.#instance?.child.pid ?? null,
      port: this.#instance?.port ?? null,
      restarts: this.#restarts,
      inFlight: this.#inFlight,
      lastError: this.#lastError,
      memoryEstimate: this.#estimate,
      lastAdmission: this.#lastAdmission,
      readyAt: this.#readyAt,
    };
  }

  /** Last diagnostic lines from llama-server (API key redacted). */
  logTail(n = 50): string[] {
    return this.#log.slice(-n);
  }

  /** EndpointProvider for LlamaServerModel: starts the server on demand. */
  readonly endpoint: EndpointProvider = (signal) => this.acquire(signal);

  async acquire(signal: AbortSignal): Promise<LocalEndpoint> {
    await this.start(signal);
    const inst = this.#instance;
    const key = this.#apiKey;
    if (!inst || !key || (this.#state !== "ready" && this.#state !== "degraded")) {
      throw new LocalInferenceError("unavailable", `Local model is ${this.#state}${this.#lastError ? `: ${this.#lastError}` : ""}`);
    }
    this.#inFlight++;
    this.#clearIdle();
    let released = false;
    return {
      baseUrl: inst.baseUrl,
      apiKey: key,
      signal: inst.life.signal,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight--;
        if (this.#inFlight === 0) this.#armIdle();
        this.#emit();
      },
    };
  }

  /** Starts the server if needed and resolves once it is serving. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.#stopping) await this.#stopping;
    if (this.#state === "ready" || this.#state === "degraded") return;
    if (this.#state === "failed") throw new LocalInferenceError("unavailable", `Local model failed: ${this.#lastError ?? "unknown error"}`);
    this.#starting ??= this.#startLoop().finally(() => { this.#starting = null; });
    await raceAbort(this.#starting, signal);
  }

  /** Clears a failed state so the next request may try again. */
  reset(): void {
    if (this.#state === "failed") {
      this.#state = "unavailable";
      this.#restarts = 0;
      this.#lastError = null;
      this.#emit();
    }
  }

  /**
   * Stop serving. In-flight requests are aborted first (closing their connections
   * makes llama-server stop generating), then the process is terminated; if it
   * has not exited within forceAfterMs the whole process tree is force-killed.
   * Windows has no graceful signal Node can deliver to a console child, and the
   * server holds no state worth flushing, so termination is the shutdown.
   */
  stop(reason = "stopped", forceAfterMs = 3_000): Promise<void> {
    this.#stopping ??= this.#stop(reason, forceAfterMs).finally(() => { this.#stopping = null; });
    return this.#stopping;
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  async #startLoop(): Promise<void> {
    const cancel = new AbortController();
    this.#startAbort = cancel;
    this.#setState("loading");
    let attempt = 0;
    for (;;) {
      try {
        await this.#launchOnce(this.#backend, cancel.signal);
        if (cancel.signal.aborted) throw new StartCancelled();
        this.#readyAt = Date.now();
        this.#lastError = null;
        this.#setState(this.#fallbackReason ? "degraded" : "ready");
        this.#armIdle();
        this.#armStable();
        return;
      } catch (err) {
        if (cancel.signal.aborted || err instanceof StartCancelled) {
          throw new LocalInferenceError("unavailable", "Local model start was cancelled by a stop request");
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.#lastError = msg;
        if (err instanceof SupervisorFatalError) {
          this.#setState("failed");
          throw new LocalInferenceError("unavailable", `Local model failed: ${msg}`);
        }
        if (this.#backend === "vulkan" && this.#opts.backend === "auto") {
          this.#fallbackReason = `Vulkan launch failed (${msg}); using CPU`;
          this.#backend = "cpu";
          continue; // immediate CPU fallback, counted as part of this attempt
        }
        attempt++;
        this.#restarts++;
        if (attempt > this.#opts.maxRestarts) {
          this.#setState("failed");
          throw new LocalInferenceError("unavailable", `Local model failed after ${attempt} attempts: ${msg}`);
        }
        this.#emit();
        await sleep(this.#opts.restartBackoffMs * 2 ** (attempt - 1));
        if (cancel.signal.aborted) throw new LocalInferenceError("unavailable", "Local model start was cancelled by a stop request");
      }
    }
  }

  async #launchOnce(backend: Backend, cancel: AbortSignal): Promise<void> {
    const rt = this.#manifest.runtime;
    const exe = path.resolve(this.#root, rt.installDir, rt.executable);

    const rtCheck = await verifyRuntime(this.#root, rt);
    if (!rtCheck.ok) throw new SupervisorFatalError(`runtime verification failed: ${rtCheck.errors.slice(0, 3).join("; ")}`);
    const modelCheck = await verifyModel(this.#root, this.#model);
    if (!modelCheck.ok) throw new SupervisorFatalError(`model verification failed: ${modelCheck.errors.join("; ")}`);

    this.#lastAdmission = admitModel(this.#estimate, this.#probe, this.#opts.minHeadroomMB);
    if (!this.#lastAdmission.ok) throw new SupervisorFatalError(this.#lastAdmission.reason!);

    await this.#killOrphan(exe);
    if (cancel.aborted) throw new StartCancelled();

    const port = await freeLoopbackPort();
    const key = randomBytes(32).toString("base64url");
    const args = [
      "--model", path.resolve(this.#root, this.#model.file),
      "--host", "127.0.0.1",
      "--port", String(port),
      "--ctx-size", String(this.#opts.contextSize),
      "--parallel", "1",
      "--threads", String(this.#opts.threads),
      "--offline",
      "--no-webui",
      "--no-slots",
      "--fit", "off",
      "--cache-ram", "0",
      "--no-cache-idle-slots",
      "--no-context-shift",
      "--reasoning", "off",
      "--log-colors", "off",
      ...(backend === "vulkan"
        ? ["--device", "Vulkan0", "--n-gpu-layers", String(this.#opts.gpuLayers)]
        : ["--device", "none", "--n-gpu-layers", "0"]),
    ];
    const env = {} as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(LLAMA_|HF_|HUGGING|GGML_)/i.test(k)) env[k] = v;
    }
    env.LLAMA_API_KEY = key;

    const child = this.#launcher(exe, args, env);
    let hasExited = false;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        hasExited = true;
        inst.hasExited = true;
        this.#pushLog(`[supervisor] llama-server exited (code ${code}, signal ${signal})`);
        resolve();
        this.#onExit(inst);
      });
      child.once("error", (err) => {
        this.#pushLog(`[supervisor] spawn error: ${err.message}`);
        if (!hasExited) { hasExited = true; inst.hasExited = true; resolve(); this.#onExit(inst); }
      });
    });
    const inst: Instance = { child, backend, port, baseUrl: `http://127.0.0.1:${port}`, life: new AbortController(), exited, hasExited: false };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      let buf = "";
      stream?.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.#pushLog(line.split(key).join("[redacted]"));
      });
    }

    this.#instance = inst;
    this.#apiKey = key;
    this.#installExitHook();
    this.#writePidFile(child.pid);

    try {
      await this.#waitReady(inst, key, cancel);
    } catch (err) {
      await this.#terminate(inst, 2_000);
      if (this.#instance === inst) { this.#instance = null; this.#apiKey = null; }
      throw err;
    }
  }

  async #waitReady(inst: Instance, key: string, cancel: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#opts.readyTimeoutMs;
    for (;;) {
      if (cancel.aborted) throw new StartCancelled();
      if (inst.hasExited) throw new Error(`llama-server exited during startup${this.#lastLogHint()}`);
      if (Date.now() > deadline) throw new Error(`llama-server not ready within ${this.#opts.readyTimeoutMs} ms`);
      const health = await probe(`${inst.baseUrl}/health`, undefined, 1_000);
      if (health === 200) break;
      await sleep(200);
    }
    // Fail closed unless the server demonstrably enforces the key.
    const anonymous = await probe(`${inst.baseUrl}/v1/models`, undefined, 2_000);
    if (anonymous !== 401) throw new SupervisorFatalError(`llama-server did not reject an unauthenticated request (HTTP ${anonymous})`);
    const authed = await probe(`${inst.baseUrl}/v1/models`, key, 2_000);
    if (authed !== 200) throw new Error(`llama-server rejected its own API key (HTTP ${authed})`);
  }

  // ── Crash handling ─────────────────────────────────────────────────────────

  #onExit(inst: Instance): void {
    inst.life.abort();
    if (this.#instance !== inst) return;      // an old or failed-launch instance
    this.#instance = null;
    this.#apiKey = null;
    this.#readyAt = null;
    this.#clearStable();
    this.#clearIdle();
    this.#removePidFile();
    if (this.#stopping || this.#starting) return; // expected (stop) or handled by the start loop
    if (this.#state !== "ready" && this.#state !== "degraded") return;

    this.#lastError = `llama-server exited unexpectedly${this.#lastLogHint()}`;
    this.#restarts++;
    if (this.#restarts > this.#opts.maxRestarts) {
      this.#setState("failed");
      return;
    }
    this.#setState("loading");
    const backoff = this.#opts.restartBackoffMs * 2 ** (this.#restarts - 1);
    this.#starting = sleep(backoff)
      .then(() => (this.#stopping ? undefined : this.#startLoop()))
      .catch(() => { /* state already reflects the failure */ })
      .finally(() => { this.#starting = null; });
  }

  // ── Stop / terminate ───────────────────────────────────────────────────────

  async #stop(reason: string, forceAfterMs: number): Promise<void> {
    this.#clearIdle();
    this.#clearStable();
    this.#startAbort?.abort(); // a launch in progress gives up at its next checkpoint
    const inst = this.#instance;
    if (inst) {
      inst.life.abort(); // in-flight requests close their connections now
      const drainUntil = Date.now() + 1_000;
      while (this.#inFlight > 0 && Date.now() < drainUntil) await sleep(25);
      await this.#terminate(inst, forceAfterMs);
    }
    if (this.#starting) await this.#starting.catch(() => {});
    // A launch that slipped past its last checkpoint may have left a process behind.
    if (this.#instance && this.#instance !== inst) await this.#terminate(this.#instance, forceAfterMs);
    this.#instance = null;
    this.#apiKey = null;
    this.#readyAt = null;
    this.#removePidFile();
    this.#removeExitHook();
    this.#pushLog(`[supervisor] stopped: ${reason}`);
    if (this.#state !== "failed") this.#setState("unavailable");
  }

  async #terminate(inst: Instance, forceAfterMs: number): Promise<void> {
    if (inst.hasExited) return;
    inst.child.kill();
    if (await settlesWithin(inst.exited, forceAfterMs)) return;
    if (process.platform === "win32" && inst.child.pid) {
      spawnSync("taskkill", ["/PID", String(inst.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      inst.child.kill("SIGKILL");
    }
    if (!(await settlesWithin(inst.exited, 2_000))) {
      this.#lastError = `could not terminate llama-server (pid ${inst.child.pid})`;
      this.#setState("failed");
    }
  }

  /** Last-resort cleanup if the host process exits without calling stop(). */
  #installExitHook(): void {
    if (this.#exitHook) return;
    this.#exitHook = () => { try { this.#instance?.child.kill(); } catch { /* exiting */ } };
    process.once("exit", this.#exitHook);
  }

  #removeExitHook(): void {
    if (this.#exitHook) process.removeListener("exit", this.#exitHook);
    this.#exitHook = null;
  }

  // ── Orphan cleanup (a previous host that died without stopping its server) ──

  #pidFile(): string {
    return path.join(this.#root, "local-inference", "run", `llama-server-${this.#model.id}.json`);
  }

  #writePidFile(pid: number | undefined): void {
    if (!pid) return;
    try {
      fs.mkdirSync(path.dirname(this.#pidFile()), { recursive: true });
      fs.writeFileSync(this.#pidFile(), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    } catch { /* best effort */ }
  }

  #removePidFile(): void {
    try { fs.rmSync(this.#pidFile(), { force: true }); } catch { /* best effort */ }
  }

  async #killOrphan(exe: string): Promise<void> {
    if (this.#orphanCheckDone || process.platform !== "win32") return;
    this.#orphanCheckDone = true;
    let pid: number;
    try {
      pid = Number(JSON.parse(fs.readFileSync(this.#pidFile(), "utf8")).pid);
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 0) return;
    // Only kill if that PID is still OUR llama-server executable (PIDs are reused).
    const q = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`], { encoding: "utf8", windowsHide: true });
    const image = (q.stdout ?? "").trim();
    if (image && path.resolve(image).toLowerCase() === path.resolve(exe).toLowerCase()) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      this.#pushLog(`[supervisor] killed orphaned llama-server pid ${pid}`);
    }
    this.#removePidFile();
  }

  // ── Timers, state, logs ────────────────────────────────────────────────────

  #armIdle(): void {
    this.#clearIdle();
    if (this.#opts.idleUnloadMs <= 0 || this.#inFlight > 0) return;
    this.#idleTimer = setTimeout(() => { void this.stop("idle unload"); }, this.#opts.idleUnloadMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #armStable(): void {
    this.#clearStable();
    this.#stableTimer = setTimeout(() => { this.#restarts = 0; this.#emit(); }, this.#opts.stableResetMs);
    this.#stableTimer.unref?.();
  }

  #clearStable(): void {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
  }

  #setState(s: SupervisorState): void {
    this.#state = s;
    this.#emit();
  }

  #emit(): void {
    try { this.#onStatus?.(this.status()); } catch { /* observers never break the supervisor */ }
  }

  #pushLog(line: string): void {
    this.#log.push(line);
    if (this.#log.length > LOG_LINES) this.#log.splice(0, this.#log.length - LOG_LINES);
  }

  #lastLogHint(): string {
    const last = this.#log.filter((l) => !l.startsWith("[supervisor]")).slice(-1)[0];
    return last ? ` (last log: ${last.slice(0, 200)})` : "";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultLauncher: Launcher = (file, args, env) =>
  spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: path.dirname(file) });

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function probe(url: string, key: string | undefined, timeoutMs: number): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => { clearTimeout(t); resolve(true); });
  });
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new LocalInferenceError("cancelled", "Cancelled while the local model was starting"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LocalInferenceError("cancelled", "Cancelled while the local model was starting"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
