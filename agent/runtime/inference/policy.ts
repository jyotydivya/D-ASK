// ─────────────────────────────────────────────────────────────────────────────
// Inference policy: offline-first by default.
//
//   DASK_INFERENCE unset / "local"  → local inference only. Every cloud model,
//                                     STT, embedding and vision call is refused.
//   DASK_INFERENCE = "cloud"        → explicit opt-in to the legacy cloud stack.
//   anything else                   → treated as "local" (fail closed).
//
// There is no automatic fallback between the two: a local failure is reported as
// a local failure, never retried against a hosted model.
// Dependency-free on purpose, so any module can import it without pulling in an SDK.
// ─────────────────────────────────────────────────────────────────────────────

export type InferenceMode = "local" | "cloud";

export function inferenceMode(env: Record<string, string | undefined> = process.env): InferenceMode {
  return env.DASK_INFERENCE?.trim().toLowerCase() === "cloud" ? "cloud" : "local";
}

export class CloudInferenceDisabledError extends Error {
  readonly code = "CLOUD_INFERENCE_DISABLED";
  constructor(readonly feature: string) {
    super(`${feature} uses a hosted service and is unavailable while DASK_INFERENCE=local (offline-first mode).`);
    this.name = "CloudInferenceDisabledError";
  }
}

/** Throws unless cloud inference was explicitly enabled. Call before any hosted-API request. */
export function assertCloudInferenceAllowed(feature: string, env: Record<string, string | undefined> = process.env): void {
  if (inferenceMode(env) !== "cloud") throw new CloudInferenceDisabledError(feature);
}

export function isCloudInferenceDisabledError(err: unknown): err is CloudInferenceDisabledError {
  return err instanceof CloudInferenceDisabledError
    || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "CLOUD_INFERENCE_DISABLED");
}
