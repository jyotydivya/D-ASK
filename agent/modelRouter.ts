// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Model Router — LLM provider abstraction
// Phase 1: Gemini-only. Add Claude/OpenAI by implementing LLMProvider.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { LLMProvider, ModelRequest, ModelResponse, ModelTier } from "../agent/types";

// ── Gemini Provider ───────────────────────────────────────────────────────────

// Use the same model that works in the existing assistant route
const MODEL_MAP: Record<ModelTier, string> = {
  fast:      "gemini-3.6-flash",   // classification, extraction
  standard:  "gemini-3.6-flash",   // agent reasoning
  reasoning: "gemini-3.6-flash",   // planning, verification
  vision:    "gemini-3.1-pro",     // vision and spatial understanding
};

class GeminiProvider implements LLMProvider {
  public readonly name = "gemini";
  private client: GoogleGenAI;

  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in environment");
    }
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = MODEL_MAP[request.tier];
    const start = Date.now();

    const response = await this.client.models.generateContent({
      model,
      contents: request.userPrompt,
      config: {
        systemInstruction: request.systemPrompt,
      },
    });

    const text = response.text ?? "";
    return {
      text,
      model,
      durationMs: Date.now() - start,
    };
  }

  async generateStructured<T>(request: ModelRequest): Promise<T> {
    const model = MODEL_MAP[request.tier];
    const start = Date.now();

    const config: Record<string, unknown> = {
      systemInstruction: request.systemPrompt,
      responseMimeType: "application/json",
    };

    if (request.outputSchema) {
      config.responseSchema = request.outputSchema;
    }

    const response = await this.client.models.generateContent({
      model,
      contents: request.userPrompt,
      config,
    });

    const text = response.text ?? "{}";
    let parsed: T;
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned) as T;
    } catch {
      throw new Error(`Model returned invalid JSON: ${text.slice(0, 300)}`);
    }

    return parsed;
  }
}

// ── OpenRouter Provider ────────────────────────────────────────────────────────

const OPENROUTER_MODEL_MAP: Record<ModelTier, string> = {
  fast:      "openai/gpt-4o-mini",          // cheap and fast
  standard:  "openai/gpt-4o-mini",          // agent reasoning
  reasoning: "anthropic/claude-3.5-sonnet", // planning, complex parsing
  vision:    "openai/gpt-4o",               // vision
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
    const model = OPENROUTER_MODEL_MAP[request.tier];
    const start = Date.now();

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.userPrompt });

    const completion = await this.client.chat.completions.create({
      model,
      messages,
    });

    const text = completion.choices[0]?.message?.content ?? "";
    return {
      text,
      model,
      durationMs: Date.now() - start,
    };
  }

  async generateStructured<T>(request: ModelRequest): Promise<T> {
    const model = OPENROUTER_MODEL_MAP[request.tier];
    
    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.userPrompt });

    const completion = await this.client.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_object" },
    });

    const text = completion.choices[0]?.message?.content ?? "{}";
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new Error(`Model returned invalid JSON: ${text.slice(0, 300)}`);
    }

    return parsed;
  }
}

// ── Model Router ──────────────────────────────────────────────────────────────

class ModelRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider = "openrouter";

  constructor() {
    // Register Gemini
    if (process.env.GEMINI_API_KEY) {
      this.providers.set("gemini", new GeminiProvider());
    }
    // Register OpenRouter
    if (process.env.OPENROUTER_API_KEY) {
      this.providers.set("openrouter", new OpenRouterProvider());
    } else {
      // Fallback if not configured
      this.defaultProvider = "gemini";
    }
  }

  /**
   * Register an additional LLM provider.
   * Example: modelRouter.registerProvider("claude", new ClaudeProvider());
   */
  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  private getProvider(name?: string): LLMProvider {
    const key = name ?? this.defaultProvider;
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`LLM provider "${key}" not registered`);
    return provider;
  }

  /**
   * Generate a text response using the appropriate model tier.
   */
  async generate(request: ModelRequest, providerName?: string): Promise<ModelResponse> {
    return this.getProvider(providerName).generate(request);
  }

  /**
   * Generate a typed structured JSON response using the appropriate tier.
   */
  async generateStructured<T>(
    request: ModelRequest,
    providerName?: string
  ): Promise<T> {
    return this.getProvider(providerName).generateStructured<T>(request);
  }

  /**
   * Convenience: quick single-turn completion at the "fast" tier.
   */
  async quick(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.generate({
      tier: "fast",
      systemPrompt,
      userPrompt,
    });
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
