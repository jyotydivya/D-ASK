/**
 * Phase 4 benchmark runner (research; uses the product runtime unmodified).
 *
 *   npx tsx research/benchmark/run.ts --model <id> --backend vulkan|cpu [--args on|off] [--pg on|off] [--gr on|off] [--structured on|off] [--tasks s01,m01] [--tag name]
 *
 * Switches (each independent)
 *   --args  request-derived argument domains (product default: on)
 *   --pg    experimental planner grounding (default: off)
 *   --gr    experimental gap replanning (default: off)
 * Both outcome rules are recorded for every run: the product's fail-closed rule
 * and the legacy model-trust rule.
 * --structured off drops the output schema (json_object mode only): ablation of
 * grammar-constrained decoding.
 *
 * Writes research/benchmark/results/<tag>.json. Never uses the network: a socket
 * guard blocks and records any non-loopback connection, and the OS TCP table of
 * the Node and llama-server processes is sampled throughout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { Brain } from "../../agent/runtime/brain";
import { Planner } from "../../agent/runtime/planner";
import { ToolRegistry } from "../../agent/runtime/toolRegistry";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime";
import { LlamaServerModel, LocalInferenceError } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import type { LanguageModel, RunReport, StructuredRequest, ToolSpec } from "../../agent/runtime/types";
import { TASKS, type BenchTask, type Need } from "./tasks";
import { CAPABILITY_TASKS } from "./capabilityTasks";

const ROOT = path.resolve(__dirname, "..", "..");
const MiB = 1024 * 1024;
const arg = (name: string, def?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelId = arg("model", "qwen2.5-0.5b-instruct-q4_k_m")!;
const backend = arg("backend", "vulkan") as "vulkan" | "cpu";
// Each switch is independent (Phase 4 follow-up: evaluate them separately).
const onOff = (name: string, def: "on" | "off") => arg(name, def) === "on";
const noArgs = !onOff("args", "on");                 // product: request-derived argument domains
const planGrounding = onOff("pg", "off");            // experimental
const gapReplanning = onOff("gr", "off");            // experimental
const structured = arg("structured", "on") !== "off";
const capabilityCheck = onOff("cap", "off");         // experimental (Phase 5)
const requestToolOffer = onOff("offer", "on");      // product (Phase 7A): offer only the tools the request checks recognise
const suite = arg("suite", "base");                  // base: Phase 4's 36 tasks; all: + the Phase 5 capability set
const only = arg("tasks")?.split(",");
const variant = `args${noArgs ? "Off" : "On"}_pg${planGrounding ? "On" : "Off"}_gr${gapReplanning ? "On" : "Off"}`;
// v2_ prefix: never overwrites the Phase 4 (v1) result files.
const tag = arg("tag", `v2_${modelId}_${backend}_${variant}${structured ? "" : "_unstructured"}`)!;

// ── Network guard (Node process) ─────────────────────────────────────────────
const blocked: string[] = [];
const origConnect = net.Socket.prototype.connect;
(net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown }).connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; path?: string } | number;
  const host = typeof first === "object" && first ? (first.host ?? (first.path ? `pipe:${first.path}` : "localhost")) : typeof args[1] === "string" ? args[1] : "localhost";
  if (!/^(127\.|::1$|localhost$|pipe:)/.test(host)) { blocked.push(host); throw new Error(`benchmark: blocked outbound connection to ${host}`); }
  return (origConnect as (...a: unknown[]) => unknown).apply(this, args);
};
delete process.env.DASK_INFERENCE; // local only

// ── Recording model wrapper ──────────────────────────────────────────────────
interface CallRecord { purpose: string; ms: number; ok: boolean; kind?: string; error?: string; output?: unknown }
class RecordingModel implements LanguageModel {
  readonly name: string;
  calls: CallRecord[] = [];
  constructor(private inner: LanguageModel, private keepSchema: boolean) { this.name = `recording(${inner.name})`; }
  async generateJson(req: StructuredRequest): Promise<unknown> {
    const t = Date.now();
    const r = this.keepSchema ? req : { ...req, schema: undefined };
    try {
      const output = await this.inner.generateJson(r);
      this.calls.push({ purpose: req.purpose, ms: Date.now() - t, ok: true, output });
      return output;
    } catch (err) {
      this.calls.push({ purpose: req.purpose, ms: Date.now() - t, ok: false, kind: err instanceof LocalInferenceError ? err.kind : "other", error: String(err).slice(0, 200) });
      throw err;
    }
  }
}

// ── Failure injection ────────────────────────────────────────────────────────
function registryFor(task: BenchTask): ToolRegistry {
  const base = createDefaultRegistry(ROOT);
  if (!task.inject) return base;
  const reg = new ToolRegistry();
  for (const d of base.list()) {
    const spec = base.get(d.name)! as ToolSpec<any, any>;
    if (d.name !== task.inject.tool) { reg.register(spec); continue; }
    let calls = 0;
    const mode = task.inject.mode;
    reg.register({
      ...spec,
      async execute(input, ctx) {
        calls++;
        if (mode === "always-fail" || (mode === "fail-first" && calls === 1)) return { ok: false, error: "injected failure", evidence: "" };
        if (mode === "hang") return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted", evidence: "" }), { once: true }));
        return spec.execute(input, ctx);
      },
    });
  }
  return reg;
}

// ── Independent oracle (hand-specified ground truth; no product grounding code) ──
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const normPath = (p: string) => { const n = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase(); return n || "."; };
function needMet(need: Need, report: RunReport): boolean {
  return report.steps.some((s) => {
    if (s.status !== "succeeded") return false;
    const out = s.outcome?.output as Record<string, unknown> | undefined;
    switch (need.kind) {
      case "time": return s.step.tool === "system.time" && String(out?.timeZone).toLowerCase() === (need.zone === "local" ? localZone : need.zone).toLowerCase();
      case "math": return s.step.tool === "math.evaluate" && typeof out?.value === "number" && Math.abs((out.value as number) - need.value) < 1e-9;
      case "info": return s.step.tool === "system.info";
      case "list": return s.step.tool === "workspace.list_dir" && normPath(String(out?.path)) === normPath(need.path);
    }
  });
}
function oracle(task: BenchTask, report: RunReport): boolean {
  if ((task as { category: string }).category === "ambiguous") return report.outcome !== "completed";
  if (task.expectRefusal) return report.outcome === "refused" && report.steps.length === 0;
  const all = task.needs.length > 0 && task.needs.every((n) => needMet(n, report));
  if (task.id === "u06") return all && report.steps.every((s) => s.step.tool === "workspace.list_dir");
  return all;
}
/** Pre-Phase-4 outcome rule (model assessment establishes completion). */
function legacyOutcome(r: RunReport): string {
  if (r.outcome === "refused" || r.outcome === "cancelled") return r.outcome;
  const total = r.steps.length, ok = r.steps.filter((s) => s.status === "succeeded").length;
  if (total === 0 || ok === 0) return "failed";
  if (ok < total) return "partial";
  const v = r.verification;
  if (!v || v.criteriaSatisfied === null) return "unverified";
  return v.criteriaSatisfied ? "completed" : "partial";
}

// ── OS sampler: llama-server memory, CPU, GPU, available RAM, non-loopback TCP ──
interface Sample { t: number; wsMB: number; cpuPct: number; availMB: number; gpuPct: number; badConns: number }
function startSampler(llamaPid: number): { proc: ChildProcess; samples: Sample[] } {
  const samples: Sample[] = [];
  const script = `
$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $p = Get-Process -Id ${llamaPid}
  $c = (Get-Counter -Counter '\\Processor(_Total)\\% Processor Time','\\Memory\\Available MBytes').CounterSamples
  $g = ((Get-Counter -Counter '\\GPU Engine(pid_${llamaPid}_*)\\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Maximum).Maximum
  $bad = @(Get-NetTCPConnection -OwningProcess ${llamaPid},${process.pid} | Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1','0.0.0.0','::' }).Count
  "S|{0}|{1}|{2}|{3}|{4}|{5}" -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $p.WorkingSet64, $c[0].CookedValue, $c[1].CookedValue, $g, $bad
  Start-Sleep -Milliseconds 500
}`;
  const proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  let buf = "";
  proc.stdout!.on("data", (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/); buf = lines.pop() ?? "";
    for (const l of lines) {
      const p = l.split("|");
      if (p[0] !== "S") continue;
      samples.push({ t: Number(p[1]), wsMB: Math.round(Number(p[2]) / MiB), cpuPct: Number(p[3]), availMB: Number(p[4]), gpuPct: Number(p[5]) || 0, badConns: Number(p[6]) || 0 });
    }
  });
  return { proc, samples };
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

async function main(): Promise<void> {
  const pool = (suite === "all" ? [...TASKS, ...CAPABILITY_TASKS] : TASKS) as unknown as (BenchTask & { answerable?: boolean })[];
  const tasks = pool.filter((t) => !only || only.includes(t.id));
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${tag}.json`);
  const meta = {
    tag, modelId, backend, variant, switches: { argumentConstraints: !noArgs, planGrounding, gapReplanning, requestToolOffer }, structured, codeVersion: tag.match(/^(v\d)_/)?.[1] ?? "v1", startedAt: new Date().toISOString(),
    machine: { cpu: os.cpus()[0]?.model.trim(), logicalCpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / MiB), os: `${os.platform()} ${os.release()}` },
    runtime: "llama.cpp b11720 win-vulkan-x64", temperature: 0, contextSize: 4096,
  };
  console.log(`[bench] ${tag}: ${tasks.length} tasks`);

  const sup = new InferenceSupervisor({ root: ROOT, modelId, backend, idleUnloadMs: 0, readyTimeoutMs: 240_000 });
  const availBeforeMB = Math.round(os.freemem() / MiB);
  const t0 = Date.now();
  try {
    await sup.start();
  } catch (err) {
    const st = sup.status();
    const result = { meta, admitted: false, reason: String(err), admission: st.lastAdmission, estimateMB: Math.round(st.memoryEstimate.totalBytes / MiB), availBeforeMB };
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`[bench] NOT ADMITTED: ${String(err)}`);
    process.exit(0);
  }
  const loadMs = Date.now() - t0;
  const st0 = sup.status();
  console.log(`[bench] ready in ${loadMs} ms on ${st0.backend} (pid ${st0.pid})`);
  const sampler = startSampler(st0.pid!);

  const inner = new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 });
  const results: unknown[] = [];
  for (const task of tasks) {
    const rec = new RecordingModel(inner, structured);
    const registry = registryFor(task);
    const runtime = new AgentRuntime({
      model: rec, registry, granted: DEFAULT_GRANTS,
      argumentConstraints: !noArgs,
      requestToolOffer,
      experimental: { planGrounding, gapReplanning, capabilityCheck },
      limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 },
    });
    const ts = Date.now();
    const report = await runtime.run({ taskId: `${tag}-${task.id}`, objective: task.objective });
    const e2eMs = Date.now() - ts;

    const brain = new Brain(rec, 1);
    const firstPlanCall = rec.calls.find((c) => c.purpose === "plan");
    // structure = registry/permissions/schema/ids/dependencies only; config = exactly what this run's planner enforces.
    const shapeCheck = firstPlanCall?.ok ? new Planner(brain, registry, { groundingCheck: false, argumentConstraints: false }).check(firstPlanCall.output, { maxSteps: 8, granted: DEFAULT_GRANTS }) : null;
    const fullCheck = firstPlanCall?.ok ? new Planner(brain, registry, { groundingCheck: planGrounding, argumentConstraints: !noArgs }).check(firstPlanCall.output, { maxSteps: 8, granted: DEFAULT_GRANTS, objective: task.objective }) : null;
    const argViolations = report.steps.filter((s) => /^Not executed:/.test(s.error ?? "")).length
      + (fullCheck && !fullCheck.ok ? (fullCheck as { errors: string[] }).errors.filter((e) => /not taken from the request|must be omitted|is required and must be one of/.test(e)).length : 0);
    const acceptedAfterRepair = !(report.error ?? "").startsWith("Planning failed");
    const firstRoundTools = [...new Set(report.steps.filter((s) => !s.step.id.startsWith("r2_")).map((s) => s.step.tool))].sort();
    const toolExact = task.expectRefusal ? report.outcome === "refused" : JSON.stringify(firstRoundTools) === JSON.stringify([...task.expectTools].sort());

    const success = oracle(task, report);
    const legacy = legacyOutcome(report);
    const allStepsOk = report.steps.length > 0 && report.steps.every((s) => s.status === "succeeded");
    const r = {
      id: task.id, category: task.category, objective: task.objective, inject: task.inject ?? null,
      answerable: task.answerable ?? !task.expectRefusal,
      outcome: report.outcome, legacyOutcome: legacy, success,
      incorrectClaim: report.outcome === "completed" && !success,
      incorrectClaimLegacy: legacy === "completed" && !success,
      missedCompletion: success && !task.expectRefusal && report.outcome !== "completed",
      missedCompletionLegacy: success && !task.expectRefusal && legacy !== "completed",
      refused: report.outcome === "refused",
      iterations: report.iterations, toolCalls: report.toolCalls,
      steps: report.steps.map((s) => ({ id: s.step.id, tool: s.step.tool, input: s.step.input, status: s.status, evidence: s.outcome?.evidence?.slice(0, 160), error: s.error })),
      firstPlan: { jsonOk: !!firstPlanCall?.ok, errorKind: firstPlanCall?.kind ?? null, shapeValid: !!shapeCheck?.ok, fullValid: !!fullCheck?.ok, errors: fullCheck && !fullCheck.ok ? (fullCheck as { errors: string[] }).errors.slice(0, 3) : [] },
      planCalls: rec.calls.filter((c) => c.purpose === "plan").length,
      argViolations,
      acceptedAfterRepair,
      toolSelection: { planned: firstRoundTools, expected: task.expectTools, exact: toolExact },
      assessor: allStepsOk ? { criteriaSatisfied: report.verification?.criteriaSatisfied ?? null, oracle: success } : null,
      independentlyVerified: report.verification?.independentlyVerified ?? false,
      e2eMs,
      modelCalls: rec.calls.map((c) => ({ purpose: c.purpose, ms: c.ms, ok: c.ok, kind: c.kind })),
      response: report.response.slice(0, 400),
      error: report.error ?? null,
    };
    results.push(r);
    console.log(`[bench] ${task.id} ${report.outcome.padEnd(10)} legacy=${legacy.padEnd(10)} success=${success} ${e2eMs}ms tools=${firstRoundTools.join("+") || "-"}`);
  }

  const tu = Date.now();
  await sup.stop("benchmark done");
  const unloadMs = Date.now() - tu;
  sampler.proc.kill();
  const s = sampler.samples;
  const result = {
    meta: { ...meta, finishedAt: new Date().toISOString() },
    admitted: true, loadMs, unloadMs, backendUsed: st0.backend, availBeforeMB,
    estimateMB: Math.round(st0.memoryEstimate.totalBytes / MiB),
    resources: {
      samples: s.length,
      peakWorkingSetMB: s.length ? Math.max(...s.map((x) => x.wsMB)) : null,
      minAvailableMB: s.length ? Math.min(...s.map((x) => x.availMB)) : null,
      cpuPctMedian: pct(s.map((x) => x.cpuPct), 50), cpuPctP95: pct(s.map((x) => x.cpuPct), 95),
      gpuPctMedian: pct(s.map((x) => x.gpuPct), 50), gpuPctP95: pct(s.map((x) => x.gpuPct), 95),
      nonLoopbackConnectionsObserved: s.reduce((a, x) => a + x.badConns, 0),
    },
    blockedOutbound: blocked,
    tasks: results,
  };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[bench] wrote ${path.relative(ROOT, outFile)}`);
  process.exit(0);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
