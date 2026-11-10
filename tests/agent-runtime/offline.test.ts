/**
 * Offline-first enforcement (Phase 3).
 * Run with: npx tsx tests/agent-runtime/offline.test.ts
 *
 *   G. import graph: the local agent path never statically reaches a cloud SDK
 *   P. DASK_INFERENCE policy (default local, fail closed)
 *   R. routes and services with cloud API keys PRESENT: every hosted call is
 *      refused, and an in-process socket guard records zero outbound connections
 *
 * Uses fake key values; nothing is ever sent. No model is loaded here (the
 * real-model run is tests/agent-runtime/offline-integration.test.ts).
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

// ── In-process network guard: records every socket connect, refuses non-loopback ──
const connections: { host: string; port: unknown }[] = [];
const origConnect = net.Socket.prototype.connect;
(net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown }).connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; port?: unknown; path?: string } | number | string;
  const host = typeof first === "object" && first ? (first.host ?? (first.path ? `pipe:${first.path}` : "localhost")) : typeof args[1] === "string" ? args[1] : "localhost";
  const port = typeof first === "object" && first ? first.port : first;
  connections.push({ host, port });
  if (!/^(127\.|::1$|localhost$|pipe:)/.test(host)) {
    throw new Error(`offline test: blocked outbound connection to ${host}:${String(port)}`);
  }
  return (origConnect as (...a: unknown[]) => unknown).apply(this, args);
};
const nonLoopback = () => connections.filter((c) => !/^(127\.|::1$|localhost$|pipe:)/.test(c.host));

// ── Import graph ─────────────────────────────────────────────────────────────
interface Edge { from: string; to: string; dynamic: boolean }
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return spec; // bare package
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), `${base}.json`]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function edgesOf(file: string): Edge[] {
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: Edge[] = [];
  // Static, value-carrying imports/exports (`import type` / `export type` are erased at compile time).
  for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\s)[^;]*?\sfrom\s+["']([^"']+)["']/gm)) {
    const to = resolveImport(file, m[2]); if (to) out.push({ from: file, to, dynamic: false });
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    const to = resolveImport(file, m[1]); if (to) out.push({ from: file, to, dynamic: false });
  }
  // Runtime dynamic import(). A type-position `import("x").Name` (erased by TypeScript)
  // is followed by a property access other than then/catch/finally, and is skipped.
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    if (m[3] && !["then", "catch", "finally"].includes(m[3])) continue;
    const to = resolveImport(file, m[1]); if (to) out.push({ from: file, to, dynamic: true });
  }
  return out;
}
function staticClosure(entry: string): { files: Set<string>; packages: Set<string>; dynamic: Edge[] } {
  const files = new Set<string>(); const packages = new Set<string>(); const dynamic: Edge[] = [];
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    if (!/\.(ts|tsx)$/.test(f)) continue;
    for (const e of edgesOf(f)) {
      if (e.dynamic) { dynamic.push(e); continue; }
      if (!path.isAbsolute(e.to)) { packages.add(e.to); continue; }
      stack.push(e.to);
    }
  }
  return { files, packages, dynamic };
}
const CLOUD_PACKAGES = /^(openai|@google\/genai|@google\/generative-ai|groq-sdk|@anthropic-ai\/sdk|@mistralai|cohere-ai)/;
const CLOUD_FILES = /(agent\/modelRouter\.ts|lib\/agent\/memory\/embeddingService\.ts|lib\/agent\/tools\/desktop\/visionControl\.ts|agent\/orchestrator\.ts)$/;

async function main(): Promise<void> {
  console.log("\n[G] Import graph of the local agent path");
  {
    const control = staticClosure(path.join(ROOT, "agent/orchestrator.ts"));
    check([...control.files].map(rel).includes("agent/modelRouter.ts") && control.packages.has("openai"), "G0 positive control: the walker does find the legacy orchestrator's cloud imports");
    const g = staticClosure(path.join(ROOT, "agent/runtime/index.ts"));
    const files = [...g.files].map(rel);
    check(![...g.packages].some((p) => CLOUD_PACKAGES.test(p)), "G1 agent/runtime/index.ts statically reaches no cloud SDK package", [...g.packages]);
    check(!files.some((f) => CLOUD_FILES.test(f)), "G2 …and no cloud-calling module (modelRouter, embeddings, vision, legacy orchestrator)", files.filter((f) => CLOUD_FILES.test(f)));
    check(files.includes("agent/runtime/inference/llamaServerModel.ts") && files.includes("agent/runtime/inference/supervisor.ts"), "G3 the local adapter and supervisor are on the path");
    // A lazy edge matters only if, followed fully (static + lazy), it can reach cloud code.
    const reachesCloud = (entry: string): boolean => {
      const seen = new Set<string>(); const stack = [entry];
      while (stack.length) {
        const f = stack.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        if (!path.isAbsolute(f)) { if (CLOUD_PACKAGES.test(f)) return true; continue; }
        if (CLOUD_FILES.test(rel(f))) return true;
        if (/\.(ts|tsx)$/.test(f)) for (const e of edgesOf(f)) stack.push(e.to);
      }
      return false;
    };
    const dyn = g.dynamic.filter((e) => reachesCloud(e.to)).map((e) => `${rel(e.from)} -> ${rel(e.to)}`).sort();
    check(JSON.stringify(dyn) === JSON.stringify(["agent/runtime/inference/index.ts -> agent/runtime/inference/cloudModel.ts"]),
      "G4 the ONLY lazy edge that can reach cloud code is the explicit DASK_INFERENCE=cloud branch", { cloudReaching: dyn, allLazy: g.dynamic.map((e) => `${rel(e.from)} -> ${rel(e.to)}`) });
    const cloudSrc = fs.readFileSync(path.join(ROOT, "agent/runtime/inference/cloudModel.ts"), "utf8");
    check(/assertCloudInferenceAllowed\(/.test(cloudSrc.split("generateJson")[1] ?? ""), "G5 the cloud adapter re-checks the policy before importing modelRouter");

    const route = staticClosure(path.join(ROOT, "app/api/tasks/route.ts"));
    check(![...route.files].map(rel).some((f) => CLOUD_FILES.test(f)) && ![...route.packages].some((p) => CLOUD_PACKAGES.test(p)),
      "G6 POST /api/tasks statically loads no cloud module (legacy orchestrator is lazy, cloud-mode only)", [...route.files].map(rel).filter((f) => CLOUD_FILES.test(f)));
    const brain = fs.readFileSync(path.join(ROOT, "agent/runtime/brain.ts"), "utf8");
    check(!/modelRouter/.test(brain.replace(/\/\/.*$/gm, "")), "G7 brain.ts no longer references the cloud router");
  }

  console.log("\n[P] DASK_INFERENCE policy");
  const policy = await import("../../agent/runtime/inference/policy");
  check(policy.inferenceMode({}) === "local", "P1 unset → local");
  check(policy.inferenceMode({ DASK_INFERENCE: "local" }) === "local" && policy.inferenceMode({ DASK_INFERENCE: " CLOUD " }) === "cloud", "P2 explicit local / cloud (trimmed, case-insensitive)");
  check(["cloudy", "on", "1", "true", "", "remote"].every((v) => policy.inferenceMode({ DASK_INFERENCE: v }) === "local"), "P3 any other value fails closed to local");
  let threw = false;
  try { policy.assertCloudInferenceAllowed("x", {}); } catch (e) { threw = policy.isCloudInferenceDisabledError(e); }
  check(threw, "P4 assertCloudInferenceAllowed throws CloudInferenceDisabledError by default");

  console.log("\n[R] Routes and services with cloud API keys present (fake values), DASK_INFERENCE unset");
  delete process.env.DASK_INFERENCE;
  delete process.env.DASK_AGENT_ENGINE;
  process.env.GROQ_API_KEY = "gsk_offline_test_fake_key";
  process.env.OPENROUTER_API_KEY = "sk-or-offline-test-fake-key";
  process.env.GEMINI_API_KEY = "offline-test-fake-key";
  const T = randomBytes(32).toString("base64url");
  process.env.DASK_API_TASK_TOKEN = T;
  process.env.DASK_API_APPROVE_TOKEN = randomBytes(32).toString("base64url");
  const authed = (url: string, body: BodyInit, contentType?: string) => new Request(url, {
    method: "POST", headers: { host: "localhost:3000", authorization: `Bearer ${T}`, ...(contentType ? { "content-type": contentType } : {}) }, body,
  });

  {
    const { modelRouter } = await import("../../agent/modelRouter");
    const n = connections.length;
    let e1: unknown = null; let e2: unknown = null;
    try { await modelRouter.generateStructured({ tier: "fast", systemPrompt: "s", userPrompt: "u" }); } catch (e) { e1 = e; }
    try { await modelRouter.quick("s", "u"); } catch (e) { e2 = e; }
    check(policy.isCloudInferenceDisabledError(e1) && policy.isCloudInferenceDisabledError(e2), "R1 modelRouter refuses (providers are registered because keys exist, but no call is made)", String(e1));
    check(connections.length === n, "R1 zero connection attempts");

    const { embeddingService } = await import("../../lib/agent/memory/embeddingService");
    let e3: unknown = null;
    try { await embeddingService.generateEmbedding("hello"); } catch (e) { e3 = e; }
    check(policy.isCloudInferenceDisabledError(e3) && connections.length === n, "R2 cloud embeddings refused, zero connections", String(e3));

    const { ModelRouterLanguageModel } = await import("../../agent/runtime/inference/cloudModel");
    let e4: unknown = null;
    try { await new ModelRouterLanguageModel().generateJson({ purpose: "plan", system: "s", user: "u", signal: new AbortController().signal }); } catch (e) { e4 = e; }
    check(policy.isCloudInferenceDisabledError(e4) && connections.length === n, "R3 the cloud agent adapter refuses even if constructed directly", String(e4));

    const stt = await import("../../app/api/stt/route");
    const fd = new FormData(); fd.append("file", new Blob([new Uint8Array(16)]), "a.webm");
    const sttRes = await stt.POST(authed("http://localhost:3000/api/stt", fd) as never);
    check(sttRes.status === 503 && (await sttRes.json()).unavailable === "cloud-inference-disabled" && connections.length === n, "R4 POST /api/stt → 503 unavailable offline, zero connections", sttRes.status);

    const assistant = await import("../../app/api/assistant/route");
    const aRes = await assistant.POST(authed("http://localhost:3000/api/assistant", JSON.stringify({ message: "hello" }), "application/json"));
    check(aRes.status === 503 && (await aRes.json()).actionType === "none" && connections.length === n, "R5 POST /api/assistant → 503 unavailable offline, zero connections", aRes.status);

    const tasks = await import("../../app/api/tasks/route");
    const { taskService } = await import("../../services/taskService");
    const { eventService } = await import("../../services/eventService");
    const before = taskService.listTasks().length;
    const legacy = await tasks.POST(authed("http://localhost:3000/api/tasks", JSON.stringify({ objective: "open notepad", engine: "legacy" }), "application/json") as never);
    check(legacy.status === 409 && taskService.listTasks().length === before && connections.length === n, "R6 engine=legacy → 409 in local mode, no task created, zero connections", legacy.status);

    // Default engine in local mode is the runtime. Inject a scripted runtime so no model loads here.
    const { AgentRuntime } = await import("../../agent/runtime/runtime");
    const { createDefaultRegistry, DEFAULT_GRANTS, resetRuntimeBridgeForTests } = await import("../../agent/runtime");
    resetRuntimeBridgeForTests();
    const bridge = (globalThis as unknown as Record<symbol, { runtime: unknown }>)[Symbol.for("dask.agentRuntime.bridge.v1")]!;
    bridge.runtime = new AgentRuntime({
      model: { name: "scripted", async generateJson(r) { return r.purpose === "plan" ? { intent: "question", goal: "g", successCriteria: ["time"], steps: [{ id: "s1", description: "t", tool: "system.time", input: {}, dependsOn: [] }] } : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "r" }; } },
      registry: createDefaultRegistry(ROOT), granted: DEFAULT_GRANTS,
    });
    const created = await tasks.POST(authed("http://localhost:3000/api/tasks", JSON.stringify({ objective: "what time is it" }), "application/json") as never);
    const { taskId } = await created.json() as { taskId: string };
    for (let i = 0; i < 100 && taskService.getTask(taskId)?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 20));
    const engine = eventService.getHistory(taskId, 50).find((e) => e.type === "task.created")?.payload.engine;
    check(created.status === 201 && engine === "runtime" && taskService.getTask(taskId)?.status === "completed", "R7 engine-less request → local agent runtime (even with cloud keys present)", { engine });
    check(nonLoopback().length === 0, "R8 no non-loopback connection was attempted anywhere in this suite", nonLoopback());

    const { SelectedLanguageModel } = await import("../../agent/runtime/inference");
    check(new SelectedLanguageModel().mode === "local", "R9 the default runtime model selects local inference");
    process.env.DASK_INFERENCE = "cloud";
    check(new SelectedLanguageModel().mode === "cloud" && (() => { try { policy.assertCloudInferenceAllowed("x"); return true; } catch { return false; } })(), "R10 cloud is reachable only with explicit DASK_INFERENCE=cloud");
    delete process.env.DASK_INFERENCE;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
