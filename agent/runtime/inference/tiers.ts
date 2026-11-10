// ─────────────────────────────────────────────────────────────────────────────
// EXPERIMENTAL (off by default): memory-aware model tiers.
//
// Prefer the stronger model only when the existing memory guard admits it; otherwise
// use the fallback. Selection happens only when no model is loaded, so a running task
// never changes model, and the old server is fully stopped before a new one starts:
// there is never more than one llama-server. The supervisor's own admission check still
// runs on every launch and is authoritative; nothing here can force a load, lower the
// headroom, or free memory by touching other applications.
// ─────────────────────────────────────────────────────────────────────────────

import type { EndpointProvider, LocalEndpoint } from "./llamaServerModel";
import { LocalInferenceError } from "./llamaServerModel";
import { PINNED_MANIFEST, findModel } from "./manifest";
import { admitModel, estimateModelMemory, mb, osMemoryProbe } from "./memory";
import { InferenceSupervisor, type SupervisorOptions } from "./supervisor";

export const DEFAULT_TIERS = {
  /** Phase 4: best task success (27/36); needs about 4.6 GB free to be admitted. */
  preferred: "qwen2.5-3b-instruct-q4_k_m",
  /** Phase 4: 22/36, 703 MB peak. 1.5B showed no advantage over it, so it is not a tier. */
  fallback: "qwen2.5-0.5b-instruct-q4_k_m",
};

export interface TierOptions {
  preferred: string;
  fallback: string;
  supervisor?: Omit<SupervisorOptions, "modelId">;
  /** After a non-memory failure of the preferred model, do not retry it for this long. */
  preferredCooldownMs?: number;
  log?: (message: string) => void;
}

export interface TierSelection {
  modelId: string;
  reason: string;
  availableMB: number;
  preferredRequiredMB: number;
  at: string;
}

export class ModelTierManager {
  readonly #opts: TierOptions;
  #current: InferenceSupervisor | null = null;
  #currentId: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #preferredBlockedUntil = 0;
  #selections: TierSelection[] = [];

  constructor(opts: TierOptions) {
    this.#opts = opts;
  }

  readonly endpoint: EndpointProvider = (signal) => {
    // Serialized, so two callers can never start two servers.
    const run = this.#queue.then(() => this.#acquire(signal));
    this.#queue = run.catch(() => {});
    return run;
  };

  status() {
    const s = this.#current?.status();
    return {
      mode: "tiers",
      modelId: this.#currentId,
      state: s?.state ?? "unavailable",
      backend: s?.backend ?? null,
      pid: s?.pid ?? null,
      restarts: s?.restarts ?? 0,
      lastError: s?.lastError ?? null,
      selections: this.#selections.slice(-5),
    };
  }

  async stop(reason: string): Promise<void> {
    await this.#queue.catch(() => {});
    const cur = this.#current;
    this.#current = null;
    this.#currentId = null;
    if (cur) await cur.stop(reason);
  }

  /** Which tier the guard would admit right now. The supervisor re-checks at launch. */
  select(): TierSelection {
    const manifest = this.#opts.supervisor?.manifest ?? PINNED_MANIFEST;
    const model = findModel(manifest, this.#opts.preferred);
    const estimate = estimateModelMemory(model, this.#opts.supervisor?.contextSize ?? model.defaultContext);
    const admission = admitModel(estimate, this.#opts.supervisor?.memoryProbe ?? osMemoryProbe, this.#opts.supervisor?.minHeadroomMB);
    const blocked = Date.now() < this.#preferredBlockedUntil;
    const usePreferred = admission.ok && !blocked;
    return {
      modelId: usePreferred ? this.#opts.preferred : this.#opts.fallback,
      reason: blocked ? "preferred model failed recently" : admission.ok ? "guard admits the preferred model" : "guard would refuse the preferred model",
      availableMB: mb(admission.availableBytes),
      preferredRequiredMB: mb(admission.requiredBytes + admission.minHeadroomBytes),
      at: new Date().toISOString(),
    };
  }

  async #acquire(signal: AbortSignal): Promise<LocalEndpoint> {
    const cur = this.#current;
    if (cur) {
      const state = cur.status().state;
      if (state === "ready" || state === "degraded" || state === "loading") return cur.acquire(signal);
      // Idle-unloaded or failed: fully stop it, then choose again.
      if (state === "failed" && this.#currentId === this.#opts.preferred) this.#block();
      await cur.stop("tier re-selection");
      this.#current = null;
      this.#currentId = null;
    }

    const selection = this.select();
    this.#selections.push(selection);
    this.#opts.log?.(`model tier: ${selection.modelId} (${selection.reason}; ${selection.availableMB} MB available, preferred needs ${selection.preferredRequiredMB} MB)`);
    try {
      return await this.#start(selection.modelId, signal);
    } catch (err) {
      if (selection.modelId === this.#opts.fallback || signal.aborted) throw err;
      // Refused or failed at launch: never force it. Stop it completely, then use the fallback.
      const message = err instanceof Error ? err.message : String(err);
      this.#opts.log?.(`preferred model unavailable (${message}); using fallback`);
      if (err instanceof LocalInferenceError && !/Insufficient physical memory/.test(message)) this.#block();
      await this.#current?.stop("preferred model failed");
      this.#current = null;
      this.#currentId = null;
      return this.#start(this.#opts.fallback, signal);
    }
  }

  #block(): void {
    this.#preferredBlockedUntil = Date.now() + (this.#opts.preferredCooldownMs ?? 300_000);
  }

  #start(modelId: string, signal: AbortSignal): Promise<LocalEndpoint> {
    const sup = new InferenceSupervisor({ ...this.#opts.supervisor, modelId });
    this.#current = sup;
    this.#currentId = modelId;
    return sup.acquire(signal);
  }
}
