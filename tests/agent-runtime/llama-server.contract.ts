/**
 * Real-binary contract tests: pinned llama-server b11720 + existing Qwen2.5-0.5B GGUF.
 * Run with: npx tsx tests/agent-runtime/llama-server.contract.ts
 *
 * Verifies that what LlamaServerModel and InferenceSupervisor ASSUME about the
 * pinned server is actually true, and records measurements (this machine only).
 * Model QUALITY is not asserted here (Phase 4); schema conformance is.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { LlamaServerModel, LocalInferenceError } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import { buildPlanSchema } from "../../agent/runtime/inference/schemas";
import { Brain } from "../../agent/runtime/brain";
import { Planner } from "../../agent/runtime/planner";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const measured: Record<string, unknown> = {};
const note = (k: string, v: unknown) => { measured[k] = v; console.log(`  MEASURED ${k}: ${JSON.stringify(v)}`); };
const ROOT = path.resolve(__dirname, "..", "..");
const never = new AbortController().signal;
const MiB = 1024 * 1024;

function ps(cmd: string): string {
  return (spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim();
}
function procMemory(pid: number): { workingSetMB: number; privateMB: number; peakWorkingSetMB: number } | null {
  const out = ps(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){"$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.PeakWorkingSet64)"}`);
  const [ws, pv, peak] = out.split(" ").map(Number);
  return ws ? { workingSetMB: Math.round(ws / MiB), privateMB: Math.round(pv / MiB), peakWorkingSetMB: Math.round(peak / MiB) } : null;
}
function gpuSharedMB(pid: number): number | null {
  const out = ps(`$s=(Get-Counter "\\GPU Process Memory(pid_${pid}_*)\\Shared Usage" -ErrorAction SilentlyContinue).CounterSamples; if($s){($s | Measure-Object CookedValue -Sum).Sum}`);
  return out ? Math.round(Number(out) / MiB) : null;
}
function tcpConnections(pid: number): { local: string; remote: string; state: string }[] {
  const out = ps(`Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress)|$($_.RemoteAddress)|$($_.State)" }`);
  return out ? out.split(/\r?\n/).map((l) => { const [local, remote, state] = l.split("|"); return { local, remote, state }; }) : [];
}
const isLoopbackOrUnspecified = (a: string) => a === "127.0.0.1" || a === "::1" || a === "0.0.0.0" || a === "::";
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function status(url: string, key?: string, init: RequestInit = {}): Promise<number> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  await res.arrayBuffer();
  return res.status;
}

async function main(): Promise<void> {
  // Peek the key only to probe the server's own behaviour (test-only, never printed).
  let lastKey = "";
  let lastBase = "";
  const spy = (sup: InferenceSupervisor) => async (signal: AbortSignal) => {
    const ep = await sup.acquire(signal);
    lastKey = ep.apiKey; lastBase = ep.baseUrl;
    return ep;
  };

  for (const backend of ["vulkan", "cpu"] as const) {
    console.log(`\n[${backend.toUpperCase()}] pinned llama-server + qwen2.5-0.5b-instruct-q4_k_m`);
    const freeBefore = os.freemem();
    const sup = new InferenceSupervisor({ root: ROOT, backend, idleUnloadMs: 0, readyTimeoutMs: 120_000 });
    note(`${backend}.memoryEstimateMB`, Math.round(sup.status().memoryEstimate.totalBytes / MiB));

    const t0 = Date.now();
    await sup.start();
    const st = sup.status();
    note(`${backend}.loadMs (hash check + spawn + model load + auth self-check)`, Date.now() - t0);
    check(st.state === "ready" && st.backend === backend, `C1 ${backend}: supervisor reaches ready on the requested backend`, { state: st.state, backend: st.backend, err: st.lastError, log: sup.logTail(8) });
    if (st.state !== "ready") { await sup.stop(); continue; }
    // b11720 does not log device placement at default verbosity; use the OS GPU counters instead.
    const gpuMB = gpuSharedMB(st.pid!);
    note(`${backend}.gpuSharedMemoryMB (Windows GPU Process Memory counter)`, gpuMB);
    if (backend === "vulkan") check(gpuMB !== null && gpuMB > 200, "C1 vulkan: weights are resident in GPU (shared) memory, i.e. offload really happened", gpuMB);
    else check(gpuMB === null || gpuMB < 50, "C1 cpu: no meaningful GPU memory in use (--device none)", gpuMB);

    const model = new LlamaServerModel({ endpoint: spy(sup), requestTimeoutMs: 120_000 });
    const pid = st.pid!;

    // ── Health / auth ──────────────────────────────────────────────────────
    await model.generateJson({ purpose: "assess", system: 'Return {"criteriaSatisfied":true,"missing":[],"needsMoreSteps":false,"reason":"x"}', user: "ok", signal: never, schema: { type: "object", properties: { criteriaSatisfied: { type: "boolean" } }, required: ["criteriaSatisfied"] } });
    check(await status(`${lastBase}/health`) === 200, "C2 /health answers 200 without credentials (readiness probe needs no key)");
    check(await status(`${lastBase}/v1/chat/completions`, undefined, { method: "POST", body: "{}" }) === 401, "C2 completion without a key → 401");
    check(await status(`${lastBase}/v1/chat/completions`, "wrong-key", { method: "POST", body: "{}" }) === 401, "C2 completion with a wrong key → 401");
    check(await status(`${lastBase}/v1/models`) === 401 && await status(`${lastBase}/v1/models`, lastKey) === 200, "C2 /v1/models needs the key (the supervisor's self-check)");
    check(await status(`${lastBase}/slots`, lastKey) !== 200, "C2 /slots is disabled (--no-slots)");
    const wrongModel = new LlamaServerModel({ endpoint: { baseUrl: lastBase, apiKey: "definitely-wrong" } });
    try { await wrongModel.generateJson({ purpose: "assess", system: "s", user: "u", signal: never }); check(false, "C2 adapter maps 401 → auth"); }
    catch (e) { check(e instanceof LocalInferenceError && e.kind === "auth", "C2 adapter maps the real 401 → auth", String(e)); }

    // ── Schema-constrained generation ─────────────────────────────────────
    const forced = await model.generateJson({
      purpose: "assess", system: "Answer the user's question in JSON.", user: "What is the capital of France?", signal: never,
      schema: { type: "object", additionalProperties: false, required: ["answer", "n"], properties: { answer: { type: "string", enum: ["zebra-42"] }, n: { type: "integer", minimum: 7, maximum: 7 } } },
    }) as Record<string, unknown>;
    check(JSON.stringify(forced) === '{"answer":"zebra-42","n":7}', "C3 the schema is enforced by the server (output forced to an answer the prompt would never produce)", forced);

    const registry = createDefaultRegistry(ROOT);
    const tools = registry.listUsable(DEFAULT_GRANTS);
    const planner = new Planner(new Brain(model, 120_000), registry);
    const tg = Date.now();
    const brain = new Brain(model, 120_000);
    const proposal = await brain.proposePlan({ objective: "What time is it, and what is 17*3?", tools, history: [], maxSteps: 8 }, never) as { steps?: { tool: string; id: string }[] };
    note(`${backend}.planGenerationMs`, Date.now() - tg);
    const planSchema = buildPlanSchema(tools, 8) as { properties: { steps: { items: { anyOf: { properties: { tool: { const: string } } }[] } } } };
    const offered = new Set(planSchema.properties.steps.items.anyOf.map((v) => v.properties.tool.const));
    check(Array.isArray(proposal.steps) && proposal.steps.every((s) => offered.has(s.tool) && /^s[0-9]{1,2}$/.test(s.id)), "C3 real plan output respects the generated schema (only offered tools, s<n> ids)", proposal);
    const verdict = planner.check(proposal, { maxSteps: 8, granted: DEFAULT_GRANTS });
    note(`${backend}.planPassesIndependentValidation`, verdict.ok ? true : (verdict as { errors: string[] }).errors);
    note(`${backend}.plan`, proposal);

    // ── Truncation ─────────────────────────────────────────────────────────
    try {
      await model.generateJson({ purpose: "plan", system: "Write a long JSON object.", user: "Describe 30 cities.", signal: never, maxTokens: 5, schema: { type: "object", properties: { cities: { type: "array", items: { type: "string" } } }, required: ["cities"] } });
      check(false, "C4 a 5-token cap yields a truncated error");
    } catch (e) {
      check(e instanceof LocalInferenceError && (e.kind === "truncated" || e.kind === "malformed"), "C4 output cut by the token cap is rejected, never parsed as partial JSON", String(e));
    }

    // ── Cancellation stops server-side generation ─────────────────────────
    const longReq = (signal: AbortSignal): StructuredRequest => ({
      purpose: "plan", system: "You write extremely long JSON.", user: "List 400 different animals with a one-sentence description each.", signal, maxTokens: 3000,
      schema: { type: "object", required: ["animals"], properties: { animals: { type: "array", items: { type: "object", required: ["name", "description"], properties: { name: { type: "string" }, description: { type: "string" } } } } } },
    });
    // Baseline: how long a short request takes on an idle server.
    const shortReq: StructuredRequest = { purpose: "assess", system: "Reply in JSON.", user: "Say ok.", signal: never, maxTokens: 16, schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } };
    let tb = Date.now(); await model.generateJson(shortReq); const baselineMs = Date.now() - tb;
    const ac = new AbortController();
    const long = model.generateJson(longReq(ac.signal)).catch((e) => e);
    await new Promise((r) => setTimeout(r, 1_500));
    const tc = Date.now();
    ac.abort();
    const longErr = await long;
    check(longErr instanceof LocalInferenceError && longErr.kind === "cancelled" && Date.now() - tc < 500, "C5 abort rejects the long request promptly", String(longErr));
    tb = Date.now(); await model.generateJson(shortReq); const afterCancelMs = Date.now() - tb;
    note(`${backend}.shortRequestMs {idle, rightAfterCancel}`, { idle: baselineMs, afterCancel: afterCancelMs });
    // With --parallel 1, a short request queued behind a still-running 3000-token generation would take many seconds.
    check(afterCancelMs < baselineMs + 3_000, "C5 server stopped generating after the client disconnected (next request not queued behind it)", { baselineMs, afterCancelMs });
    note(`${backend}.cancelLogLines`, sup.logTail(200).filter((l) => /cancel|closed|disconnect/i.test(l)).slice(-3));

    // ── Memory and network, measured ──────────────────────────────────────
    const mem = procMemory(pid);
    note(`${backend}.llamaServerMemoryMB`, mem);
    note(`${backend}.systemAvailableMB {beforeStart, now}`, { beforeStart: Math.round(freeBefore / MiB), now: Math.round(os.freemem() / MiB) });
    const conns = tcpConnections(pid);
    note(`${backend}.llamaServerTcp`, conns);
    check(conns.length > 0 && conns.every((c) => isLoopbackOrUnspecified(c.local) && (c.remote === "0.0.0.0" || c.remote === "::" || isLoopbackOrUnspecified(c.remote)) && c.local !== "0.0.0.0"),
      "C6 every llama-server TCP endpoint is loopback (listens on 127.0.0.1, no remote peers)", conns);

    // ── Full runtime through the real model (outcome recorded, not asserted) ─
    const rt = new AgentRuntime({ model, registry, granted: DEFAULT_GRANTS, limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 } });
    const tr = Date.now();
    const report = await rt.run({ taskId: `contract-${backend}`, objective: "What time is it?" });
    note(`${backend}.runtimeTask`, { ms: Date.now() - tr, outcome: report.outcome, steps: report.steps.map((s) => `${s.step.tool}:${s.status}`), verification: report.verification?.method, error: report.error });
    check(report.outcome !== "completed" || report.steps.every((s) => s.status === "succeeded" && !!s.outcome?.evidence), "C7 if the runtime reports completed, every step succeeded with evidence");

    // ── Shutdown ───────────────────────────────────────────────────────────
    const ts = Date.now();
    await sup.stop("contract test done");
    note(`${backend}.stopMs`, Date.now() - ts);
    check(sup.status().state === "unavailable" && !alive(pid), "C8 stop terminates the server process", { pid });
    const stale = new LlamaServerModel({ endpoint: { baseUrl: lastBase, apiKey: lastKey } });
    try { await stale.generateJson(shortReq); check(false, "C8 stopped server → unavailable"); }
    catch (e) { check(e instanceof LocalInferenceError && e.kind === "unavailable", "C8 request to the stopped server → unavailable (connection refused)", String(e)); }
  }

  console.log("\nMEASUREMENTS (this machine: i5-1335U, 15.7 GB usable, Iris Xe)");
  console.log(JSON.stringify(measured, null, 2));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
