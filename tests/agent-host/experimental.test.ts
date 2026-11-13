/**
 * Phase 5 experimental additions, both OFF by default.
 *   npx tsx tests/agent-host/experimental.test.ts
 *
 *   C. capability check: deterministic, can only refuse, off unless enabled
 *   T. model tiers: guard-driven selection, one server at a time, never forced
 * The tier tests use the fake server process from tests/agent-runtime/fixtures; hash
 * verification, memory admission and process handling are the real supervisor code.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessCapability } from "../../agent/runtime/capabilityCheck";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { AgentRuntime } from "../../agent/runtime/runtime";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import type { ArtifactManifest } from "../../agent/runtime/inference/manifest";
import { DEFAULT_TIERS, ModelTierManager } from "../../agent/runtime/inference/tiers";
import { SupervisorFatalError, type Launcher } from "../../agent/runtime/inference/supervisor";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 400)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const never = new AbortController().signal;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Counting implements LanguageModel {
  readonly name = "counting";
  calls = 0;
  constructor(private plan: unknown) {}
  async generateJson(req: StructuredRequest) {
    this.calls++;
    return req.purpose === "plan" ? this.plan : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "r" };
  }
}
const timePlan = { intent: "task", goal: "g", successCriteria: ["t"], steps: [{ id: "s1", description: "t", tool: "system.time", input: {} }] };

async function main(): Promise<void> {
  console.log("\n[C] Capability check");
  const reg = createDefaultRegistry(ROOT);
  const verdict = (o: string) => assessCapability(reg, o).verdict;
  check(verdict("Send an email to my boss") === "unsupported", "C1 unsupported action");
  check(verdict("Search the web for today's weather forecast") === "unsupported", "C2 Phase 4 u04 is unsupported, even though 'today' fires the time check");
  check(verdict("Delete the docs folder") === "unsupported", "C3 Phase 4 u03 is unsupported, even though 'folder' fires the listing check");
  check(verdict("What time is it?") === "supported" && verdict("What is (17+25)*2?") === "supported", "C4 plainly supported requests");
  check(verdict("How many hours are in a week?") === "ambiguous", "C5 a paraphrase is ambiguous, not refused");
  check(verdict("Do the thing we discussed") === "ambiguous", "C6 an unclear request is ambiguous, not refused");
  check(verdict("List the files in the open folder") !== "unsupported", "C7 'open' outside command position is not an action");

  {
    const m = new Counting(timePlan);
    const r = await new AgentRuntime({ model: m, registry: reg, granted: DEFAULT_GRANTS }).run({ taskId: "c8", objective: "Send an email to my boss" });
    check(m.calls > 0 && r.outcome !== "refused", "C8 OFF by default: the check does not run unless enabled", { calls: m.calls, outcome: r.outcome });
    check(r.outcome !== "completed", "C8 …and verification still stops a false completion");
  }
  const on = (m: LanguageModel) => new AgentRuntime({ model: m, registry: reg, granted: DEFAULT_GRANTS, experimental: { capabilityCheck: true } });
  {
    const m = new Counting(timePlan);
    const r = await on(m).run({ taskId: "c9", objective: "Send an email to my boss" });
    check(r.outcome === "refused" && m.calls === 0 && r.toolCalls === 0, "C9 ON: refused with no model call and no tool call", { outcome: r.outcome, calls: m.calls });
    check(/email/.test(r.response), "C9 the refusal names what cannot be done", r.response);
  }
  {
    const m = new Counting(timePlan);
    const r = await on(m).run({ taskId: "c10", objective: "What time is it?" });
    check(r.outcome === "completed" && m.calls === 2, "C10 ON: a supported request still goes through the planner and verifier", { outcome: r.outcome, calls: m.calls });
  }
  {
    // It can only refuse: a plan for an ungranted tool is still refused by the planner.
    const bad = new Counting({ ...timePlan, steps: [{ id: "s1", description: "x", tool: "shell.exec", input: {} }] });
    const r = await on(bad).run({ taskId: "c11", objective: "What time is it?" });
    check(r.outcome === "failed" && r.toolCalls === 0, "C11 ON: passing the check grants nothing; the planner still rejects an unknown tool", r.outcome);
  }
  {
    const m = new Counting(timePlan);
    const r = await on(m).run({ taskId: "c12", objective: "Do the thing we discussed" });
    check(m.calls > 0 && r.outcome === "unverified", "C12 ON: ambiguous goes to the planner, and verification caps it at unverified", { outcome: r.outcome });
  }

  console.log("\n[T] Memory-aware model tiers");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dask-tier-"));
  const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  fs.mkdirSync(path.join(tmp, "rt"));
  fs.mkdirSync(path.join(tmp, "models"));
  fs.writeFileSync(path.join(tmp, "rt", "llama-server.exe"), "exe");
  fs.writeFileSync(path.join(tmp, "models", "big.gguf"), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(tmp, "models", "small.gguf"), Buffer.alloc(1024, 2));
  const arch = { nLayer: 2, nKvHead: 1, headDim: 8, nVocab: 100 };
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    runtime: { id: "f", version: "0", commit: "0", os: "windows", arch: "x64", variant: "vulkan", source: "n/a", archiveSha256: "n/a", installDir: "rt", executable: "llama-server.exe", files: { "llama-server.exe": sha(path.join(tmp, "rt", "llama-server.exe")) } },
    models: [
      { id: "big", file: "models/big.gguf", sizeBytes: 2048, sha256: sha(path.join(tmp, "models", "big.gguf")), architecture: arch, defaultContext: 512 },
      { id: "small", file: "models/small.gguf", sizeBytes: 1024, sha256: sha(path.join(tmp, "models", "small.gguf")), architecture: arch, defaultContext: 512 },
    ],
  };
  const fixture = path.join(ROOT, "tests/agent-runtime/fixtures/fake-llama-server.mjs");
  let live = 0, maxLive = 0;
  const started: string[] = [];
  const launcher = (env2: Record<string, string> = {}): Launcher => (_f, args, env) => {
    const model = path.basename(args[args.indexOf("--model") + 1], ".gguf");
    started.push(model);
    const child = spawn(process.execPath, [fixture, ...args], { env: { ...env, ...env2 }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    live++; maxLive = Math.max(maxLive, live);
    child.once("exit", () => { live--; });
    return child;
  };
  const GB = 1024 ** 3;
  let availableBytes = 16 * GB;
  const memoryProbe = () => ({ availableBytes, totalBytes: 16 * GB });
  const mk = (extra: Partial<ConstructorParameters<typeof ModelTierManager>[0]> = {}, launch = launcher()) =>
    new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest, memoryProbe, launcher: launch, idleUnloadMs: 0, restartBackoffMs: 20, readyTimeoutMs: 10_000 }, ...extra });
  const model = (t: ModelTierManager) => new LlamaServerModel({ endpoint: t.endpoint });
  const ask = (t: ModelTierManager) => model(t).generateJson({ purpose: "assess", system: "s", user: "u", signal: never });
  const reset = () => { started.length = 0; maxLive = 0; };

  try {
    check(DEFAULT_TIERS.preferred.includes("3b") && DEFAULT_TIERS.fallback.includes("0.5b"), "T0 default tiers are 3B, then 0.5B; 1.5B is not a tier");
    {
      reset();
      const t = mk();
      await ask(t);
      check(t.status().modelId === "big" && started.join() === "big", "T1 the guard admits the preferred model → it is used", t.status());
      await ask(t);
      check(started.length === 1, "T2 while loaded it is reused, not reloaded");
      await t.stop("test");
    }
    {
      reset();
      availableBytes = 1 * GB; // below model + 2000 MB headroom for the big model estimate
      const small = new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest, memoryProbe: () => ({ availableBytes: 3 * GB, totalBytes: 16 * GB }), launcher: launcher(), idleUnloadMs: 0 } });
      const sel = small.select();
      check(sel.modelId === "big", "T3 sanity: 3 GB admits a tiny test model", sel);
      availableBytes = 16 * GB;
    }
    {
      // Make the preferred model's requirement real: pretend it is large.
      reset();
      const heavy: ArtifactManifest = { ...manifest, models: [{ ...manifest.models[0], architecture: { ...arch, nVocab: 8_000_000 } }, manifest.models[1]] };
      let avail = 3 * GB;
      const t = new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest: heavy, memoryProbe: () => ({ availableBytes: avail, totalBytes: 16 * GB }), launcher: launcher(), idleUnloadMs: 300, restartBackoffMs: 20 } });
      await ask(t);
      check(t.status().modelId === "small" && started.join() === "small", "T4 the guard would refuse the preferred model → fallback, and it is never launched", { s: t.status(), started });
      check(/refuse/.test(t.status().selections[0].reason), "T4 the reason is recorded", t.status().selections[0]);

      // Memory frees up: no switch while loaded; re-selection only after idle unload.
      avail = 64 * GB;
      await ask(t);
      check(t.status().modelId === "small" && started.length === 1, "T5 a loaded model is not switched mid-use, even if more memory appears");
      await sleep(600);
      check(t.status().state === "unavailable", "T6 idle unload released the model", t.status().state);
      await ask(t);
      check(t.status().modelId === "big" && started.join() === "small,big", "T7 next use re-selects: upgraded to the preferred model", started);
      check(maxLive === 1, "T8 never more than one server process during the switch", maxLive);

      // And down again when memory is short.
      await sleep(600);
      avail = 3 * GB;
      await ask(t);
      check(t.status().modelId === "small" && started.join() === "small,big,small" && maxLive === 1, "T9 downgrade works the same way; still one process at a time", { started, maxLive });
      await t.stop("test");
    }
    {
      reset();
      // select() sees enough memory, then memory disappears before the launch: the supervisor's own
      // check is authoritative and refuses, and the tier manager falls back rather than forcing it.
      let probes = 0;
      const heavy: ArtifactManifest = { ...manifest, models: [{ ...manifest.models[0], architecture: { ...arch, nVocab: 8_000_000 } }, manifest.models[1]] };
      const t = new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest: heavy, memoryProbe: () => ({ availableBytes: ++probes === 1 ? 64 * GB : 3 * GB, totalBytes: 16 * GB }), launcher: launcher(), idleUnloadMs: 0 } });
      await ask(t);
      check(t.status().modelId === "small" && !started.includes("big"), "T10 a guard refusal at launch time → fallback, preferred never launched", { started, s: t.status() });
      await t.stop("test");
    }
    {
      reset();
      // The preferred model fails for a non-memory reason: fall back and do not retry it immediately.
      const badPreferred: ArtifactManifest = { ...manifest, models: [{ ...manifest.models[0], sha256: "0".repeat(64) }, manifest.models[1]] };
      const t = new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest: badPreferred, memoryProbe, launcher: launcher(), idleUnloadMs: 300 } });
      await ask(t);
      check(t.status().modelId === "small", "T11 a preferred model failing verification → fallback", t.status());
      await sleep(600);
      await ask(t);
      check(/failed recently/.test(t.status().selections.at(-1)!.reason), "T12 it is not retried immediately after a real failure", t.status().selections.at(-1));
      await t.stop("test");
    }
    {
      reset();
      const t = mk();
      const results = await Promise.all([ask(t), ask(t), ask(t)]);
      check(results.length === 3 && started.length === 1 && maxLive === 1, "T13 concurrent callers start exactly one server", started);
      const pid = t.status().pid;
      await t.stop("test");
      await sleep(100);
      let alive = false;
      try { process.kill(pid!, 0); alive = true; } catch { /* gone */ }
      check(!alive && live === 0, "T14 stop leaves no server process", { alive, live });
    }
    {
      let threw = false;
      try { new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest, minHeadroomMB: 100, launcher: launcher() } }).select(); await ask(new ModelTierManager({ preferred: "big", fallback: "small", supervisor: { root: tmp, manifest, minHeadroomMB: 100, launcher: launcher() } })); }
      catch (e) { threw = e instanceof SupervisorFatalError || /headroom/i.test(String(e)); }
      check(threw, "T15 the tier manager cannot lower the guard's headroom");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
