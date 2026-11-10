// ─────────────────────────────────────────────────────────────────────────────
// LlamaServerModel — LanguageModel backed by a local llama-server process.
//
// - Loopback only: every endpoint is re-validated before each request, and
//   redirects are refused so a server cannot bounce a request off the machine.
// - Per-launch API key sent as a bearer token; never logged, never included in
//   errors (any echo of it in a server message is redacted).
// - Schema-constrained output when the request carries a schema.
// - Cancellation and timeout abort the HTTP request itself (llama-server stops
//   generating when the connection closes), not just the awaiting promise.
// - Response size is capped while streaming the body in.
//
// Output is returned as parsed JSON and is still UNTRUSTED: the planner and
// verifier validate it independently. Conforming to the schema proves nothing.
// ─────────────────────────────────────────────────────────────────────────────

import type { LanguageModel, StructuredRequest } from "../types";
import { assertLoopbackBaseUrl } from "./loopback";
import { DEFAULT_MAX_TOKENS } from "./schemas";

export interface LocalEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Aborted when the server instance behind this endpoint is stopping. */
  signal?: AbortSignal;
  /** Called exactly once when the request using this endpoint has finished. */
  release?: () => void;
}

/** Supplies a ready endpoint (the supervisor starts the server on demand). */
export type EndpointProvider = (signal: AbortSignal) => Promise<LocalEndpoint>;

export type LocalInferenceErrorKind =
  | "endpoint"     // endpoint failed validation (e.g. not loopback)
  | "unavailable"  // server not running, refused the connection, still loading, or stopping
  | "auth"         // API key rejected
  | "http"         // other non-2xx response
  | "timeout"
  | "cancelled"
  | "oversized"    // response larger than maxResponseBytes
  | "truncated"    // generation stopped at the token limit
  | "malformed";   // response or model output is not the expected JSON

export class LocalInferenceError extends Error {
  constructor(readonly kind: LocalInferenceErrorKind, message: string) {
    super(message);
    this.name = "LocalInferenceError";
  }
}

export interface LlamaServerModelOptions {
  endpoint: EndpointProvider | { baseUrl: string; apiKey: string };
  name?: string;
  /** Generated-token caps per purpose. */
  maxTokens?: Partial<Record<StructuredRequest["purpose"], number>>;
  /** Upper bound for one HTTP request, including generation. */
  requestTimeoutMs?: number;
  /** Largest accepted response body. */
  maxResponseBytes?: number;
  temperature?: number;
}

const DEFAULTS = { requestTimeoutMs: 60_000, maxResponseBytes: 256 * 1024, temperature: 0 };

export class LlamaServerModel implements LanguageModel {
  readonly name: string;
  readonly #endpoint: EndpointProvider;
  readonly #maxTokens: Record<StructuredRequest["purpose"], number>;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #temperature: number;

  constructor(opts: LlamaServerModelOptions) {
    const ep = opts.endpoint;
    if (typeof ep === "function") {
      this.#endpoint = ep;
    } else {
      const fixed = { baseUrl: ep.baseUrl, apiKey: ep.apiKey };
      this.#endpoint = async () => fixed;
    }
    this.name = opts.name ?? "llama-server (local)";
    this.#maxTokens = { ...DEFAULT_MAX_TOKENS, ...opts.maxTokens };
    this.#timeoutMs = opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.#maxBytes = opts.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    this.#temperature = opts.temperature ?? DEFAULTS.temperature;
  }

  async generateJson(req: StructuredRequest): Promise<unknown> {
    if (req.signal.aborted) throw new LocalInferenceError("cancelled", "Cancelled before the request was sent");

    let endpoint: LocalEndpoint;
    try {
      endpoint = await this.#endpoint(req.signal);
    } catch (err) {
      if (err instanceof LocalInferenceError) throw err;
      if (req.signal.aborted) throw new LocalInferenceError("cancelled", "Cancelled while waiting for the local model");
      throw new LocalInferenceError("unavailable", `Local model unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return await this.#request(endpoint, req);
    } finally {
      endpoint.release?.();
    }
  }

  async #request(endpoint: LocalEndpoint, req: StructuredRequest): Promise<unknown> {
    let base: string;
    try {
      base = assertLoopbackBaseUrl(endpoint.baseUrl);
    } catch (err) {
      throw new LocalInferenceError("endpoint", err instanceof Error ? err.message : String(err));
    }
    const key = endpoint.apiKey;
    const scrub = (text: string) => (key ? text.split(key).join("[redacted]") : text).slice(0, 300);

    const controller = new AbortController();
    let why: "timeout" | "cancelled" | "stopping" | null = null;
    const abort = (reason: typeof why) => { if (!why) why = reason; controller.abort(); };
    const onCaller = () => abort("cancelled");
    const onStop = () => abort("stopping");
    req.signal.addEventListener("abort", onCaller, { once: true });
    endpoint.signal?.addEventListener("abort", onStop, { once: true });
    if (endpoint.signal?.aborted) abort("stopping");
    const timer = setTimeout(() => abort("timeout"), this.#timeoutMs);

    const failure = (err: unknown): LocalInferenceError => {
      if (err instanceof LocalInferenceError) return err;
      if (why === "timeout") return new LocalInferenceError("timeout", `Local model request timed out after ${this.#timeoutMs} ms`);
      if (why === "cancelled") return new LocalInferenceError("cancelled", "Local model request cancelled");
      if (why === "stopping") return new LocalInferenceError("unavailable", "Local model server is stopping");
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
        return new LocalInferenceError("unavailable", `Local model server is not reachable (${code})`);
      }
      return new LocalInferenceError("unavailable", `Local model request failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
    };

    try {
      const body = {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        stream: false,
        temperature: this.#temperature,
        max_tokens: req.maxTokens ?? this.#maxTokens[req.purpose],
        response_format: req.schema
          ? { type: "json_schema", json_schema: { name: req.purpose, strict: true, schema: req.schema } }
          : { type: "json_object" },
        cache_prompt: true,
      };

      let res: Response;
      try {
        res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (err) {
        throw failure(err);
      }

      let text: string;
      try {
        text = await readCapped(res, this.#maxBytes, () => abort(null));
      } catch (err) {
        throw failure(err);
      }

      if (res.status === 401 || res.status === 403) throw new LocalInferenceError("auth", `Local model server rejected the API key (HTTP ${res.status})`);
      if (res.status === 503) throw new LocalInferenceError("unavailable", `Local model server is not ready (HTTP 503): ${scrub(errorText(text))}`);
      if (!res.ok) throw new LocalInferenceError("http", `Local model server error (HTTP ${res.status}): ${scrub(errorText(text))}`);

      return parseCompletion(text);
    } catch (err) {
      throw failure(err);
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onCaller);
      endpoint.signal?.removeEventListener("abort", onStop);
    }
  }
}

async function readCapped(res: Response, cap: number, abort: () => void): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    abort();
    throw new LocalInferenceError("oversized", `Local model response too large (${declared} bytes > ${cap})`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      abort();
      throw new LocalInferenceError("oversized", `Local model response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error.message === "string") return j.error.message;
  } catch { /* not JSON */ }
  return text;
}

function parseCompletion(text: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new LocalInferenceError("malformed", "Local model server returned a non-JSON response");
  }
  const choice = (envelope as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new LocalInferenceError("malformed", "Local model response has no message content");
  if (choice?.finish_reason === "length") {
    throw new LocalInferenceError("truncated", "Local model output was cut off at the token limit");
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new LocalInferenceError("malformed", "Local model output is not valid JSON");
  }
}
