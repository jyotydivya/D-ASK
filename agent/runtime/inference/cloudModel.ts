// ─────────────────────────────────────────────────────────────────────────────
// Legacy cloud adapter (Groq → OpenRouter via agent/modelRouter.ts).
//
// Reachable ONLY when DASK_INFERENCE=cloud is set explicitly. The local agent
// path never imports this file (see inference/index.ts), and the check below
// refuses at call time as a second line of defence. There is no fallback from
// local inference to this adapter.
// ─────────────────────────────────────────────────────────────────────────────

import type { LanguageModel, StructuredRequest } from "../types";
import { assertCloudInferenceAllowed } from "./policy";

export class ModelRouterLanguageModel implements LanguageModel {
  readonly name = "model-router (cloud)";

  async generateJson(req: StructuredRequest): Promise<unknown> {
    assertCloudInferenceAllowed("Cloud agent inference");
    const { modelRouter } = await import("../../modelRouter");
    return modelRouter.generateStructured<unknown>({
      tier: req.purpose === "plan" ? "reasoning" : "fast",
      systemPrompt: req.system,
      userPrompt: req.user,
    });
  }
}
