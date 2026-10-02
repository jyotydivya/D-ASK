// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Model Router — LLM provider abstraction with failover ladder
// Inspired by Mark-LV's core/gemini.py — every rung has a cooldown so a model
// that's down is skipped for a while instead of paid for on every call.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import type { LLMProvider, ModelRequest, ModelResponse, ModelTier } from "../agent/types";

// ── Cooldown Tracker ──────────────────────────────────────────────────────────
// When a model fails (429, 503, timeout), we skip it for COOLDOWN_MS.
// This is the whole point of the ladder: one model's daily limit is one limit,
// a ladder means the sum of them.

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_MS = 15_000; // 15 second timeout on all calls

const _cooldowns = new Map<string, number>(); // model → timestamp when cooldown expires

function isOnCooldown(model: string): boolean {
  const until = _cooldowns.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    _cooldowns.delete(model);
    return false;
  }
  return true;
}

function setCooldown(model: string): void {
  _cooldowns.set(model, Date.now() + COOLDOWN_MS);
  console.warn(`[ModelRouter] ⏱ ${model} on cooldown for ${COOLDOWN_MS / 1000}s`);
}

// ── Groq Provider ─────────────────────────────────────────────────────────────
// Uses GROQ_API_KEY — fast inference, generous free tier.

const GROQ_MODEL_LADDERS: Record<ModelTier, string[]> = {
  fast: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "gemma2-9b-it",
  ],
  standard: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ],
  reasoning: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ],
  vision: [
    "llama-3.2-90b-vision-preview",
    "llama-3.2-11b-vision-preview",
  ],
};

class GroqProvider implements LLMProvider {
  public readonly name = "groq";
  private client: OpenAI;

  constructor() {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set in environment");
    }
    this.client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const ladder = GROQ_MODEL_LADDERS[request.tier];
    const start = Date.now();
    let lastError: any = null;

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: formatContent(request.userPrompt) });

    for (const model of ladder) {
      if (isOnCooldown(model)) continue;

      try {
        const completion = await Promise.race([
          this.client.chat.completions.create({ model, messages }),
          timeoutPromise<never>(TIMEOUT_MS),
        ]);

        const text = completion.choices[0]?.message?.content ?? "";
        return { text, model, durationMs: Date.now() - start };
      } catch (err: any) {
        lastError = err;
        setCooldown(model);
        console.warn(`[Groq] ${model} failed (${err?.message?.slice(0, 80) ?? err}), trying next rung...`);
      }
    }

    throw new Error(`All Groq models in ${request.tier} ladder failed. Last: ${lastError?.message || lastError}`);
  }

  async generateStructured<T>(request: ModelRequest): Promise<T> {
    const ladder = GROQ_MODEL_LADDERS[request.tier];
    let lastError: any = null;

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt + "\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no commentary." });
    }
    messages.push({ role: "user", content: formatContent(request.userPrompt) });

    for (const model of ladder) {
      if (isOnCooldown(model)) continue;

      try {
        const completion = await Promise.race([
          this.client.chat.completions.create({
            model,
            messages,
            response_format: { type: "json_object" },
          }),
          timeoutPromise<never>(TIMEOUT_MS),
        ]);

        const text = completion.choices[0]?.message?.content ?? "{}";
        return parseJSON<T>(text);
      } catch (err: any) {
        lastError = err;
        setCooldown(model);
        console.warn(`[Groq] Structured ${model} failed (${err?.message?.slice(0, 80) ?? err}), trying next rung...`);
      }
    }

    throw new Error(`All Groq structured models in ${request.tier} ladder failed. Last: ${lastError?.message || lastError}`);
  }
}

// ── OpenRouter Provider with Failover Ladder ──────────────────────────────────

const OPENROUTER_MODEL_LADDERS: Record<ModelTier, string[]> = {
  fast: [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-preview",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-small-3.1-24b-instruct",
  ],
  standard: [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-preview",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  reasoning: [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-preview",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  vision: [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-preview",
    "openai/gpt-4o",
  ],
};

class OpenRouterProvider implements LLMProvider {
  public readonly name = "openrouter";
  private client: OpenAI;

  constructor() {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not set in environment");
    }
    this.client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "D-ASK Jarvis",
      }
    });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const ladder = OPENROUTER_MODEL_LADDERS[request.tier];
    const start = Date.now();
    let lastError: any = null;

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: formatContent(request.userPrompt) });

    for (const model of ladder) {
      if (isOnCooldown(model)) continue;

      try {
        const completion = await Promise.race([
          this.client.chat.completions.create({ model, messages }),
          timeoutPromise<never>(TIMEOUT_MS),
        ]);

        const text = completion.choices[0]?.message?.content ?? "";
        return { text, model, durationMs: Date.now() - start };
      } catch (err: any) {
        lastError = err;
        setCooldown(model);
        console.warn(`[OpenRouter] ${model} failed (${err?.message?.slice(0, 80) ?? err}), trying next rung...`);
      }
    }

    throw new Error(`All OpenRouter models in ${request.tier} ladder failed. Last: ${lastError?.message || lastError}`);
  }

  async generateStructured<T>(request: ModelRequest): Promise<T> {
    const ladder = OPENROUTER_MODEL_LADDERS[request.tier];
    let lastError: any = null;

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt + "\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no commentary." });
    }
    messages.push({ role: "user", content: formatContent(request.userPrompt) });

    for (const model of ladder) {
      if (isOnCooldown(model)) continue;

      try {
        const completion = await Promise.race([
          this.client.chat.completions.create({
            model,
            messages,
            response_format: { type: "json_object" },
          }),
          timeoutPromise<never>(TIMEOUT_MS),
        ]);

        const text = completion.choices[0]?.message?.content ?? "{}";
        return parseJSON<T>(text);
      } catch (err: any) {
        lastError = err;
        setCooldown(model);
        console.warn(`[OpenRouter] Structured ${model} failed (${err?.message?.slice(0, 80) ?? err}), trying next rung...`);
      }
    }

    throw new Error(`All OpenRouter structured models in ${request.tier} ladder failed. Last: ${lastError?.message || lastError}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatContent(userPrompt: unknown): any {
  if (typeof userPrompt === "string") return userPrompt;
  if (Array.isArray(userPrompt)) {
    return userPrompt.map((part: any) => {
      if (typeof part === "string") return { type: "text", text: part };
      if (part.text && !part.inlineData) return { type: "text", text: part.text };
      if (part.inlineData) {
        const mime = part.inlineData.mimeType || "image/jpeg";
        return {
          type: "image_url",
          image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
        };
      }
      return part;
    });
  }
  return userPrompt;
}

function parseJSON<T>(text: string): T {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`Model returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }
}

function timeoutPromise<T>(ms: number): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Model call timed out after ${ms}ms`)), ms)
  );
}

// ── Model Router ──────────────────────────────────────────────────────────────
// Tries providers in order: Groq first (fastest, free), then OpenRouter.
// If both fail, throws with the last error.

class ModelRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private providerOrder: string[] = [];

  constructor() {
    // Register Groq first — fastest inference, generous free tier
    if (process.env.GROQ_API_KEY) {
      try {
        this.providers.set("groq", new GroqProvider());
        this.providerOrder.push("groq");
        console.log("[ModelRouter] ✓ Groq provider registered");
      } catch (e) {
        console.warn("[ModelRouter] ✗ Groq provider failed to initialize:", e);
      }
    }

    // Register OpenRouter — widest model selection, paid
    if (process.env.OPENROUTER_API_KEY) {
      try {
        this.providers.set("openrouter", new OpenRouterProvider());
        this.providerOrder.push("openrouter");
        console.log("[ModelRouter] ✓ OpenRouter provider registered");
      } catch (e) {
        console.warn("[ModelRouter] ✗ OpenRouter provider failed to initialize:", e);
      }
    }

    if (this.providerOrder.length === 0) {
      console.error("[ModelRouter] ⚠ No LLM providers registered! Set GROQ_API_KEY or OPENROUTER_API_KEY.");
    }
  }

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
    if (!this.providerOrder.includes(name)) {
      this.providerOrder.push(name);
    }
  }

  private getProvider(name?: string): LLMProvider {
    if (name) {
      const provider = this.providers.get(name);
      if (!provider) throw new Error(`LLM provider "${name}" not registered`);
      return provider;
    }
    // Return first available
    for (const key of this.providerOrder) {
      const p = this.providers.get(key);
      if (p) return p;
    }
    throw new Error("No LLM providers registered");
  }

  /**
   * Generate a text response — tries providers in order with full failover.
   */
  async generate(request: ModelRequest, providerName?: string): Promise<ModelResponse> {
    if (providerName) {
      return this.getProvider(providerName).generate(request);
    }

    let lastError: any = null;
    for (const key of this.providerOrder) {
      const provider = this.providers.get(key);
      if (!provider) continue;

      try {
        return await provider.generate(request);
      } catch (err: any) {
        lastError = err;
        console.warn(`[ModelRouter] Provider ${key} failed for generate, trying next...`);
      }
    }

    throw new Error(`All providers failed. Last error: ${lastError?.message || lastError}`);
  }

  /**
   * Generate a typed structured JSON response — tries providers in order.
   */
  async generateStructured<T>(request: ModelRequest, providerName?: string): Promise<T> {
    if (providerName) {
      return this.getProvider(providerName).generateStructured<T>(request);
    }

    let lastError: any = null;
    for (const key of this.providerOrder) {
      const provider = this.providers.get(key);
      if (!provider) continue;

      try {
        return await provider.generateStructured<T>(request);
      } catch (err: any) {
        lastError = err;
        console.warn(`[ModelRouter] Provider ${key} failed for generateStructured, trying next...`);
      }
    }

    throw new Error(`All providers failed for structured. Last error: ${lastError?.message || lastError}`);
  }

  /**
   * Convenience: quick single-turn completion at the "fast" tier.
   */
  async quick(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.generate({ tier: "fast", systemPrompt, userPrompt });
    return response.text;
  }

  /**
   * Convenience: generate structured JSON at the "reasoning" tier.
   */
  async plan<T>(
    systemPrompt: string,
    userPrompt: string,
    outputSchema?: Record<string, unknown>
  ): Promise<T> {
    return this.generateStructured<T>({
      tier: "reasoning",
      systemPrompt,
      userPrompt,
      outputSchema,
    });
  }
}

// Singleton
export const modelRouter = new ModelRouter();

// Re-export types
export type { LLMProvider, ModelRequest, ModelResponse };
