// ─────────────────────────────────────────────────────────────────────────────
// Product entry point: the D-ASK stdio agent host. Started by the .NET daemon.
//
//   node dist/agent-host/agent/host/stdioHost.js
//
// Required environment (set by the daemon):
//   DASK_AGENT_HOST_TOKEN   per-launch secret; the first request must present it
//   DASK_ROOT               repository root (manifest paths, models, runtime)
// Optional: DASK_WORKSPACE_ROOT, DASK_LOCAL_MODEL, DASK_LOCAL_BACKEND, DASK_LOCAL_CTX,
//   DASK_LOCAL_IDLE_MS, DASK_EXPERIMENTAL_CAPABILITY_CHECK=1, DASK_EXPERIMENTAL_MODEL_TIERS=1,
//   DASK_FS_ROOTS (extra folders the filesystem tools may read, separated by ";")
//
// Imports only local-inference modules: no cloud adapter, cloud SDK or test model is
// reachable from here (checked by tests/agent-host/host-protocol.test.ts). There is no
// network listener in this process; llama-server listens on loopback under the supervisor.
// ─────────────────────────────────────────────────────────────────────────────

import { DaemonCallBridge } from "./desktopBridge";
import { claimStdout, runStdioHost, scrubCloudCredentials, takeToken } from "./stdio";
import { AgentRuntime } from "../runtime/runtime";
import { DEFAULT_GRANTS } from "../runtime/defaults";
import { createHostRegistry } from "../runtime/hostRegistry";
import path from "node:path";
import { BrowserSessions, PlaywrightEngine, daskProfileDir } from "../runtime/browser/playwrightEngine";
import { MemoryStore } from "../runtime/memory/memoryStore";
import { createPlanningMemory } from "../runtime/memory/planningContext";
import { PluginManager } from "../runtime/plugins/pluginManager";
import { createPluginCapabilities } from "../runtime/plugins/capabilities";
import { rootsFromEnv } from "../runtime/tools/fileAccess";
import { LlamaServerModel } from "../runtime/inference/llamaServerModel";
import { inferenceMode } from "../runtime/inference/policy";
import { InferenceSupervisor, type Backend } from "../runtime/inference/supervisor";
import { ModelTierManager, DEFAULT_TIERS } from "../runtime/inference/tiers";
import { KnowledgeService } from "../runtime/knowledge/service";
import { KnowledgeStore } from "../runtime/knowledge/store";
import { LlamaEmbedder } from "../runtime/knowledge/embedder";

const io = claimStdout();

function fatal(message: string): never {
  io.log(`refusing to start: ${message}`);
  process.exit(2);
}

function intEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const token = takeToken();
if (!token) fatal("DASK_AGENT_HOST_TOKEN is missing or too short");
if (process.stdin.isTTY) fatal("stdin is a terminal; this host is only started by the D-ASK daemon");
if (inferenceMode() !== "local") fatal("DASK_INFERENCE must be local; the agent host never uses cloud inference");
scrubCloudCredentials();

const root = process.env.DASK_ROOT;
if (!root) fatal("DASK_ROOT is not set");

const backendEnv = process.env.DASK_LOCAL_BACKEND;
const backend: "auto" | Backend = backendEnv === "vulkan" || backendEnv === "cpu" ? backendEnv : "auto";
const supervisorOptions = { root, backend, contextSize: intEnv("DASK_LOCAL_CTX"), idleUnloadMs: intEnv("DASK_LOCAL_IDLE_MS") };

// One model owner either way: a single supervisor, or (experimental) a tier manager that
// keeps at most one supervisor running. The guard inside the supervisor is never bypassed.
let endpoint: ConstructorParameters<typeof LlamaServerModel>[0]["endpoint"];
let modelStatus: () => unknown;
let stopModel: () => Promise<void>;
if (process.env.DASK_EXPERIMENTAL_MODEL_TIERS === "1") {
  const tiers = new ModelTierManager({ ...DEFAULT_TIERS, supervisor: supervisorOptions, log: io.log });
  endpoint = tiers.endpoint;
  modelStatus = () => tiers.status();
  stopModel = () => tiers.stop("agent host shutdown");
} else {
  // Diagnostics (opt-in): every model-supervisor status change is logged to stderr (no key, no request text).
  // DASK_AGENT_MODEL_DIAGNOSTICS=1 enables ONLY this log, leaving every protocol message unchanged (used by acceptance runs);
  // DASK_AGENT_DIAGNOSTICS=1 enables it together with the progress diagnostics.
  const diagModel = process.env.DASK_AGENT_DIAGNOSTICS === "1" || process.env.DASK_AGENT_MODEL_DIAGNOSTICS === "1";
  const MB = (n: number | undefined) => (typeof n === "number" ? Math.round(n / 1048576) : null);
  const supervisor = new InferenceSupervisor({
    ...supervisorOptions, modelId: process.env.DASK_LOCAL_MODEL || undefined,
    onStatus: diagModel ? (s) => io.log(`model status: ${JSON.stringify({
      state: s.state, modelId: s.modelId, backend: s.backend, fallbackReason: s.fallbackReason, pid: s.pid, restarts: s.restarts, inFlight: s.inFlight,
      lastError: s.lastError, estimateMB: MB(s.memoryEstimate?.totalBytes),
      admission: s.lastAdmission ? { ok: s.lastAdmission.ok, availableMB: MB(s.lastAdmission.availableBytes), requiredMB: MB(s.lastAdmission.requiredBytes),
        minHeadroomMB: MB(s.lastAdmission.minHeadroomBytes), projectedHeadroomMB: MB(s.lastAdmission.projectedHeadroomBytes) } : null,
      readyAt: s.readyAt })}`) : undefined,
  });
  endpoint = supervisor.endpoint;
  modelStatus = () => {
    const s = supervisor.status();
    return { state: s.state, modelId: s.modelId, backend: s.backend, restarts: s.restarts, lastError: s.lastError };
  };
  stopModel = () => supervisor.stop("agent host shutdown");
}

// Phase 7B.1b: read-only desktop observation, only when the daemon launched us with it (and then only if hello agrees).
const desktop = process.env.DASK_AGENT_DESKTOP === "1" ? new DaemonCallBridge() : undefined;

// Browser stage 1 (read pages the user names, local Chromium): off unless the daemon/user enables it for this host.
// Stage 2 (approved actions) additionally needs the daemon bridge; the daemon offers browser.request_action only when
// AgentHost:BrowserActions is on. The persistent profile is D-ASK's own and opt-in (DASK_BROWSER_PROFILE=persistent).
const browser = process.env.DASK_AGENT_BROWSER === "1"
  ? new PlaywrightEngine({
      ...(process.env.DASK_BROWSER_PROFILE === "persistent" ? { profileDir: daskProfileDir() } : {}),
      evidenceDir: path.join(path.dirname(daskProfileDir()), "browser-evidence"),
    })
  : undefined;
const browserSessions = browser && desktop ? new BrowserSessions(browser) : undefined;
// Local persistent memory (SQLite on this computer): off unless enabled (AgentHost:Memory).
const memory = process.env.DASK_AGENT_MEMORY === "1" ? new MemoryStore() : undefined;
const granted = new Set([...DEFAULT_GRANTS, ...(desktop ? ["read:desktop" as const, "request:desktop_action" as const] : []), ...(browser ? ["network" as const] : []), ...(memory ? ["memory:read" as const, "memory:write" as const] : [])]);

const registry = createHostRegistry(process.env.DASK_WORKSPACE_ROOT || root, {
  fileRoots: rootsFromEnv(process.env.DASK_FS_ROOTS),
  desktop,
  browser,
  browserSessions,
  memory,
  onRootsRejected: (rejected) => {
    for (const r of rejected) io.log(`file root refused: ${r.reason}`);
  },
});
// Dynamic plugins (AgentHost:Plugins): the daemon's approved list is re-read before every task; approved plugins run only
// in the sandbox (agent/runtime/plugins). Off: no plugin tool exists.
const plugins = process.env.DASK_AGENT_PLUGINS === "1" && process.env.DASK_PLUGINS_DIR && process.env.DASK_PLUGINS_APPROVED
  ? new PluginManager({ pluginsDir: process.env.DASK_PLUGINS_DIR, approvedPath: process.env.DASK_PLUGINS_APPROVED, runtimeDir: path.join(root!, "agent", "runtime", "plugins"), log: io.log,
      // files.read and memory.read run in the host, bounded by the same file rules and the user-only memory filter, and only after the per-request permission check.
      capabilities: createPluginCapabilities({ workspaceRoot: process.env.DASK_WORKSPACE_ROOT || root!, extraRoots: rootsFromEnv(process.env.DASK_FS_ROOTS), memory }) })
  : undefined;

const model = new LlamaServerModel({ endpoint, requestTimeoutMs: 120_000 });
const agentRuntime = new AgentRuntime({
  model,
  registry,
  // read:desktop and request:desktop_action only with the bridge; never desktop:actuate or process:spawn.
  // network only with the browser (pages the user names); never desktop:actuate or process:spawn.
  granted,
  // The user's own saved memories as advisory planning context (only with AgentHost:Memory; see planningContext.ts).
  ...(memory ? { memory: createPlanningMemory(memory) } : {}),
  // No approvalGate: the runtime's default denies every approval-required tool.
  limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 },
  // Plain informational questions that no tool serves are answered by the local model (runtime/conversation.ts); DASK_AGENT_CONVERSATION=0 turns it off.
  conversation: process.env.DASK_AGENT_CONVERSATION !== "0",
  experimental: { capabilityCheck: process.env.DASK_EXPERIMENTAL_CAPABILITY_CHECK === "1" },
});

// Local knowledge (RAG) and Research Mode: on by default (DASK_AGENT_KNOWLEDGE=0 turns it off). Its own SQLite file
// (knowledge.db, never memory.db); embeddings from the pinned bge-small model on the same llama.cpp runtime. Indexing reads only
// the workspace, DASK_FS_ROOTS and DASK_KNOWLEDGE_ROOTS folders. If the database cannot be opened the host starts without it.
let knowledge: KnowledgeService | undefined;
let embedder: LlamaEmbedder | undefined;
if (process.env.DASK_AGENT_KNOWLEDGE !== "0") {
  try {
    const store = new KnowledgeStore();
    embedder = new LlamaEmbedder({ root: root!, log: io.log });
    knowledge = new KnowledgeService({
      store, embedder: embedder.available() ? embedder : null, model, log: io.log,
      // Optional online research: the SAME policy-locked local browser as browser.read_page, only when browser reading is enabled (AgentHost:BrowserRead).
      ...(browser ? { fetchPage: (url: string, signal: AbortSignal) => browser!.read(url, signal) } : {}),
      workspaceRoot: process.env.DASK_WORKSPACE_ROOT || root!,
      extraRoots: [...rootsFromEnv(process.env.DASK_KNOWLEDGE_ROOTS), ...rootsFromEnv(process.env.DASK_FS_ROOTS)],
    });
    if (store.interruptedRuns) io.log(`knowledge: ${store.interruptedRuns} interrupted indexing run(s) recorded; finished documents were kept`);
  } catch (e) { io.log(`knowledge unavailable: ${e instanceof Error ? e.message : String(e)}`); }
}

// Before every task: plugin tools are registered or removed to match the approved list (a revoked plugin disappears at once).
// Knowledge / research requests (deterministic grammar, knowledge/service.ts) are served by the knowledge engine; everything else goes to the planner.
const runtime = { run: async (o: Parameters<AgentRuntime["run"]>[0]) => {
  if (knowledge) { const r = await knowledge.run({ taskId: o.taskId, objective: o.objective, signal: o.signal, emit: (e) => o.sink?.emit(e) }); if (r) return r; }
  if (plugins) await plugins.sync(registry).catch((e) => io.log(`plugin sync failed: ${String(e)}`));
  return agentRuntime.run(o);
} };

runStdioHost({ token: token!, runtime, model, knowledgeClaims: knowledge ? (o) => knowledge!.claims(o) : undefined, intentTrace: process.env.DASK_AGENT_INTENT_TRACE === "1" ? (e) => io.log(`[intent-trace] ${JSON.stringify(e)}`) : undefined, modelStatus, stopModel: async () => { await browserSessions?.closeAll(); memory?.close(); await embedder?.stop(); knowledge?.close(); await stopModel(); }, desktop, diagnostics: process.env.DASK_AGENT_DIAGNOSTICS === "1" }, io);
io.log(`started (pid ${process.pid}, node ${process.version})`);
