// ─────────────────────────────────────────────────────────────────────────────
// Local embeddings for the knowledge index. One small model (BAAI bge-small-en-v1.5, MIT licence, 384 dimensions, q8_0 GGUF,
// ~37 MB on disk, ~75 MB resident) served by the SAME pinned llama.cpp runtime the agent already ships, in embedding mode, on
// loopback with a per-launch API key. No cloud, no second LLM, no ONNX dependency.
//
// Lifecycle: started on first use, stopped after `idleMs` without requests and on host shutdown. Before starting it checks the
// runtime files against the pinned manifest, the model file against its pinned SHA-256, and that enough memory is free.
// The same model embeds documents and queries (queries get bge's retrieval instruction prefix, as the model card specifies).
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PINNED_MANIFEST, sha256File, verifyRuntime } from "../inference/manifest";

export interface Embedder {
  /** Identifies the vector space; vectors from different ids are never compared. */
  readonly modelId: string;
  readonly dim: number;
  /** Unit-length vectors, one per text. Throws when embeddings are unavailable. */
  embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<Float32Array[]>;
  status(): { state: "stopped" | "starting" | "ready" | "failed"; lastError: string | null; pid: number | null };
  stop(): Promise<void>;
}

export const EMBED_MODEL = Object.freeze({
  id: "bge-small-en-v1.5-q8_0",
  file: "models/bge-small-en-v1.5-q8_0.gguf",
  sizeBytes: 36_806_944,
  sha256: "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514",
  dim: 384,
  queryPrefix: "Represent this sentence for searching relevant passages: ",
  /** bge's position limit is 512 tokens; inputs are cut to this many characters first and halved again if the server refuses. */
  maxInputChars: 1400,
});

/** Free memory the embedder needs before it starts (its own ~75 MB plus a margin that protects the main model's guard). */
export const EMBED_MIN_FREE_BYTES = 400 * 1024 * 1024;

export interface LlamaEmbedderOptions {
  root: string;
  idleMs?: number;
  threads?: number;
  log?: (m: string) => void;
  freeMem?: () => number;
}

export class LlamaEmbedder implements Embedder {
  readonly modelId = EMBED_MODEL.id;
  readonly dim = EMBED_MODEL.dim;
  #child: ChildProcess | null = null;
  #url = "";
  #key = "";
  #starting: Promise<void> | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #state: "stopped" | "starting" | "ready" | "failed" = "stopped";
  #lastError: string | null = null;
  #verified = false;
  constructor(private readonly opts: LlamaEmbedderOptions) {}

  status() { return { state: this.#state, lastError: this.#lastError, pid: this.#child?.pid ?? null }; }

  /** True when the model file is present (it may still fail verification at start). */
  available(): boolean { return fs.existsSync(path.resolve(this.opts.root, EMBED_MODEL.file)); }

  async embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.#ensure(signal);
    this.#touch();
    const out: Float32Array[] = [];
    // Small batches keep each request inside the server's batch and make cancellation prompt.
    for (let i = 0; i < texts.length; i += 8) {
      if (signal?.aborted) throw new Error("Cancelled");
      const batch = texts.slice(i, i + 8).map((t) => (kind === "query" ? EMBED_MODEL.queryPrefix : "") + t.slice(0, EMBED_MODEL.maxInputChars));
      out.push(...(await this.#request(batch, signal)));
    }
    this.#touch();
    return out;
  }

  async #request(inputs: string[], signal?: AbortSignal, depth = 0): Promise<Float32Array[]> {
    const res = await fetch(`${this.#url}/v1/embeddings`, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#key}` },
      body: JSON.stringify({ input: inputs }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    if (!res.ok) {
      // Too many tokens for one input: halve the inputs and retry (bounded).
      if (depth < 3 && /too large|exceed|context|batch/i.test(body)) return this.#request(inputs.map((t) => t.slice(0, Math.ceil(t.length / 2))), signal, depth + 1);
      throw new Error(`embedding request failed (HTTP ${res.status})`);
    }
    const json = JSON.parse(body) as { data?: { embedding?: number[]; index?: number }[] };
    const data = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== inputs.length) throw new Error("embedding response does not match the request");
    return data.map((d) => {
      const v = Float32Array.from(d.embedding ?? []);
      if (v.length !== this.dim) throw new Error(`embedding has ${v.length} dimensions, expected ${this.dim}`);
      return normalize(v);
    });
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => { void this.stop(); }, this.opts.idleMs ?? 90_000);
    this.#idle.unref?.();
  }

  async #ensure(signal?: AbortSignal): Promise<void> {
    if (this.#state === "ready" && this.#child && this.#child.exitCode === null) return;
    if (!this.#starting) this.#starting = this.#start().finally(() => { this.#starting = null; });
    if (!signal) return this.#starting;
    await Promise.race([this.#starting, new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true }))]);
  }

  async #start(): Promise<void> {
    this.#state = "starting";
    try {
      const root = this.opts.root;
      const modelFile = path.resolve(root, EMBED_MODEL.file);
      if (!fs.existsSync(modelFile)) throw new Error(`embedding model missing: ${EMBED_MODEL.file}`);
      if (!this.#verified) {
        const st = fs.statSync(modelFile);
        if (st.size !== EMBED_MODEL.sizeBytes || (await sha256File(modelFile)) !== EMBED_MODEL.sha256) throw new Error("embedding model does not match its pinned SHA-256");
        const rt = await verifyRuntime(root, PINNED_MANIFEST.runtime);
        if (!rt.ok) throw new Error(`runtime verification failed: ${rt.errors.slice(0, 2).join("; ")}`);
        this.#verified = true;
      }
      const free = (this.opts.freeMem ?? os.freemem)();
      if (free < EMBED_MIN_FREE_BYTES) throw new Error(`not enough free memory for the embedding model (${Math.round(free / 1048576)} MB free, ${EMBED_MIN_FREE_BYTES / 1048576} MB needed)`);
      const exe = path.resolve(root, PINNED_MANIFEST.runtime.installDir, PINNED_MANIFEST.runtime.executable);
      const port = await freePort();
      this.#key = randomBytes(32).toString("base64url");
      const env = {} as NodeJS.ProcessEnv;
      for (const [k, v] of Object.entries(process.env)) if (!/^(LLAMA_|HF_|HUGGING|GGML_)/i.test(k)) env[k] = v;
      env.LLAMA_API_KEY = this.#key;
      const child = spawn(exe, [
        "--model", modelFile, "--embedding", "--pooling", "cls",
        "--host", "127.0.0.1", "--port", String(port),
        "--ctx-size", "512", "--batch-size", "512", "--ubatch-size", "512", "--parallel", "1",
        "--threads", String(this.opts.threads ?? Math.max(2, Math.min(4, os.cpus().length - 2))),
        "--device", "none", "--n-gpu-layers", "0", "--offline", "--no-webui", "--log-colors", "off",
      ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, cwd: path.dirname(exe) });
      let tail = "";
      child.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-600); });
      child.once("exit", (code) => { if (this.#child === child) { this.#child = null; if (this.#state === "ready") this.#state = "stopped"; this.opts.log?.(`embedder exited (code ${code})`); } });
      this.#child = child;
      this.#url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`embedding server exited during startup (${tail.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "no log"})`);
        if (Date.now() > deadline) { child.kill(); throw new Error("embedding server not ready within 30 s"); }
        const ok = await fetch(`${this.#url}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      // The server must refuse a request without the key (it is reachable by any local process).
      const anon = await fetch(`${this.#url}/v1/embeddings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"input\":[\"x\"]}", signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
      if (anon !== 401) { child.kill(); throw new Error(`embedding server did not reject an unauthenticated request (HTTP ${anon})`); }
      this.#state = "ready";
      this.#lastError = null;
      this.opts.log?.(`embedder ready (pid ${child.pid})`);
    } catch (e) {
      this.#state = "failed";
      this.#lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.#idle) { clearTimeout(this.#idle); this.#idle = null; }
    const c = this.#child;
    this.#child = null;
    if (this.#state !== "failed") this.#state = "stopped";
    if (c && c.exitCode === null) {
      c.kill();
      await new Promise<void>((r) => { const t = setTimeout(r, 3000); c.once("exit", () => { clearTimeout(t); r(); }); });
    }
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const a = srv.address(); const p = typeof a === "object" && a ? a.port : 0; srv.close(() => (p ? resolve(p) : reject(new Error("no free port")))); });
  });
}
