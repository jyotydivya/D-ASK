// ─────────────────────────────────────────────────────────────────────────────
// Language-model selection for the agent runtime.
//
//   DASK_INFERENCE unset/local → LlamaServerModel + InferenceSupervisor (default)
//   DASK_INFERENCE=cloud       → legacy cloud adapter (explicit opt-in only)
//
// No fallback in either direction. This module has no static import of any
// cloud SDK or of agent/modelRouter.ts; the cloud adapter is loaded only inside
// the cloud branch (checked by tests/agent-runtime/offline-import-graph.test.ts).
//
// Local-model settings (all optional):
//   DASK_LOCAL_MODEL     model id from artifacts.json (default: first entry, 0.5B)
//   DASK_LOCAL_BACKEND   auto | vulkan | cpu        (default: auto = Vulkan, CPU fallback)
//   DASK_LOCAL_CTX       context size in tokens      (default: the model's defaultContext)
//   DASK_LOCAL_IDLE_MS   idle unload delay, 0 = never (default: 300000)
// ─────────────────────────────────────────────────────────────────────────────

import type { LanguageModel, StructuredRequest } from "../types";
import { LlamaServerModel } from "./llamaServerModel";
import { inferenceMode } from "./policy";
import { InferenceSupervisor, type Backend } from "./supervisor";

export { LlamaServerModel, LocalInferenceError } from "./llamaServerModel";
export { InferenceSupervisor } from "./supervisor";
export { inferenceMode, assertCloudInferenceAllowed, CloudInferenceDisabledError } from "./policy";

const SUPERVISOR_KEY = Symbol.for("dask.localInference.supervisor.v1");

function intEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Process-wide supervisor (one model owner per host process). */
export function getLocalSupervisor(): InferenceSupervisor {
  const g = globalThis as unknown as Record<symbol, InferenceSupervisor | undefined>;
  const backend = process.env.DASK_LOCAL_BACKEND as "auto" | Backend | undefined;
  return (g[SUPERVISOR_KEY] ??= new InferenceSupervisor({
    modelId: process.env.DASK_LOCAL_MODEL || undefined,
    backend: backend === "vulkan" || backend === "cpu" ? backend : "auto",
    contextSize: intEnv("DASK_LOCAL_CTX"),
    idleUnloadMs: intEnv("DASK_LOCAL_IDLE_MS"),
  }));
}

export function createLocalLanguageModel(supervisor: InferenceSupervisor = getLocalSupervisor()): LlamaServerModel {
  return new LlamaServerModel({ endpoint: supervisor.endpoint, name: `llama-server (local, ${supervisor.status().modelId})` });
}

/**
 * The model the agent runtime uses by default. The mode is read once, on first
 * use, and never changes for the life of the process.
 */
export class SelectedLanguageModel implements LanguageModel {
  #model: Promise<LanguageModel> | null = null;
  readonly mode = inferenceMode();

  get name(): string {
    return this.mode === "cloud" ? "model-router (cloud, explicit opt-in)" : "llama-server (local)";
  }

  generateJson(req: StructuredRequest): Promise<unknown> {
    this.#model ??= this.mode === "cloud"
      ? import("./cloudModel").then((m) => new m.ModelRouterLanguageModel())
      : Promise.resolve(createLocalLanguageModel());
    return this.#model.then((m) => m.generateJson(req));
  }
}
