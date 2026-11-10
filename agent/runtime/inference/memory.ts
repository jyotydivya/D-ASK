// ─────────────────────────────────────────────────────────────────────────────
// Memory admission for the local model server.
//
// Follows the daemon's rule (ResourceManager.CanAllocateModelAsync): refuse to
// load unless available physical memory minus the requirement leaves at least
// MinModelLoadHeadroomMB (2000 MB). Unlike the daemon, the requirement is NOT
// the file size alone: it adds the KV cache, compute buffers and runtime
// overhead. These are ESTIMATES; the contract tests record measured values.
//
// "Available" is os.freemem(), which on Windows is libuv's
// GlobalMemoryStatusEx().ullAvailPhys — the same figure the daemon uses. It
// already excludes memory held by other running processes (HUD, daemon, Node).
// ─────────────────────────────────────────────────────────────────────────────

import os from "node:os";
import type { ModelArtifact } from "./manifest";

const MiB = 1024 * 1024;

/** Same value as the daemon's MinModelLoadHeadroomMB. Not lowered for any model. */
export const DEFAULT_MIN_HEADROOM_MB = 2000;

/** Process image, runtime DLLs, HTTP server, driver allocations (estimate). */
export const RUNTIME_OVERHEAD_BYTES = 160 * MiB;

export interface MemoryEstimate {
  weightsBytes: number;
  kvCacheBytes: number;
  computeBytes: number;
  overheadBytes: number;
  totalBytes: number;
  contextSize: number;
  basis: "estimate";
}

export function estimateModelMemory(model: ModelArtifact, contextSize: number, ubatch = 512): MemoryEstimate {
  const a = model.architecture;
  // K and V, f16 (2 bytes), per layer, per KV head, per head dim, per context token.
  const kvCacheBytes = 2 * a.nLayer * a.nKvHead * a.headDim * contextSize * 2;
  // Upper bound on the compute buffer: one f32 logit row per ubatch token.
  const computeBytes = ubatch * a.nVocab * 4;
  const weightsBytes = model.sizeBytes;
  const overheadBytes = RUNTIME_OVERHEAD_BYTES;
  return {
    weightsBytes,
    kvCacheBytes,
    computeBytes,
    overheadBytes,
    totalBytes: weightsBytes + kvCacheBytes + computeBytes + overheadBytes,
    contextSize,
    basis: "estimate",
  };
}

export interface MemorySnapshot {
  availableBytes: number;
  totalBytes: number;
}

export type MemoryProbe = () => MemorySnapshot;

export const osMemoryProbe: MemoryProbe = () => ({ availableBytes: os.freemem(), totalBytes: os.totalmem() });

export interface MemoryAdmission {
  ok: boolean;
  availableBytes: number;
  requiredBytes: number;
  minHeadroomBytes: number;
  projectedHeadroomBytes: number;
  reason?: string;
}

export function admitModel(estimate: MemoryEstimate, probe: MemoryProbe, minHeadroomMB = DEFAULT_MIN_HEADROOM_MB): MemoryAdmission {
  const { availableBytes } = probe();
  const minHeadroomBytes = minHeadroomMB * MiB;
  const projected = availableBytes - estimate.totalBytes;
  const ok = projected >= minHeadroomBytes;
  return {
    ok,
    availableBytes,
    requiredBytes: estimate.totalBytes,
    minHeadroomBytes,
    projectedHeadroomBytes: projected,
    ...(ok ? {} : {
      reason: `Insufficient physical memory: ${mb(availableBytes)} MB available, model needs ~${mb(estimate.totalBytes)} MB ` +
        `(estimate), leaving ${mb(projected)} MB < required headroom ${minHeadroomMB} MB`,
    }),
  };
}

export const mb = (bytes: number) => Math.round(bytes / MiB);
