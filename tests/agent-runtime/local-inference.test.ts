/**
 * Local inference — adapter (Phase 1) and supervisor (Phase 2) tests.
 * Run with: npx tsx tests/agent-runtime/local-inference.test.ts
 *
 * No real model and no real llama-server: the adapter is tested against a fake
 * HTTP server on 127.0.0.1, the supervisor against tests/agent-runtime/fixtures/
 * fake-llama-server.mjs launched through the supervisor's launcher seam (hash
 * verification, memory admission, readiness, auth self-check, restarts and
 * shutdown are all the real code paths).
 *
 *   M. LlamaServerModel against a fake HTTP server
 *   S. model-facing schema generation
 *   V. independent validation: schema-valid output is still checked
 *   U. InferenceSupervisor with a fake server process
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LlamaServerModel, LocalInferenceError } from "../../agent/runtime/inference/llamaServerModel";
import { assertLoopbackBaseUrl } from "../../agent/runtime/inference/loopback";
import { ASSESSMENT_OUTPUT_SCHEMA, buildPlanSchema, toModelSchema } from "../../agent/runtime/inference/schemas";
import { InferenceSupervisor, SupervisorFatalError, type Launcher } from "../../agent/runtime/inference/supervisor";
import type { ArtifactManifest } from "../../agent/runtime/inference/manifest";
import { Brain } from "../../agent/runtime/brain";
import { Planner } from "../../agent/runtime/planner";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { ToolRegistry } from "../../agent/runtime/toolRegistry";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime";
import type { LanguageModel, StructuredRequest, ToolSpec } from "../../agent/runtime/types";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = new AbortController().signal;

async function expectError(p: Promise<unknown>): Promise<LocalInferenceError | Error | null> {
  try { await p; return null; } catch (e) { return e as Error; }
}
const kindOf = (e: unknown) => (e instanceof LocalInferenceError ? e.kind : `not-LocalInferenceError:${String(e)}`);

// ── Fake llama-server HTTP endpoint ──────────────────────────────────────────

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
interface Fake { url: string; requests: { headers: http.IncomingHttpHeaders; body: string; url: string }[]; closedEarly: number; setHandler(h: Handler): void; close(): Promise<void> }

async function fakeServer(initial: Handler): Promise<Fake> {
  let handler = initial;
  const fake = { requests: [], closedEarly: 0 } as unknown as Fake;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { fake.requests.push({ headers: req.headers, body, url: req.url ?? "" }); handler(req, body, res); });
    res.on("close", () => { if (!res.writableEnded) fake.closedEarly++; });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.setHandler = (h) => { handler = h; };
  fake.close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  return fake;
}

const KEY = "test-key-" + "x".repeat(32);
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const completion = (content: unknown, finish = "stop") => ({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finish }] });
const authorised = (req: http.IncomingMessage) => req.headers.authorization === `Bearer ${KEY}`;

const planReq = (signal: AbortSignal = never, extra: Partial<StructuredRequest> = {}): StructuredRequest =>
  ({ purpose: "plan", system: "sys", user: "usr", signal, schema: { type: "object" }, ...extra });

// ── Test-only JSON Schema conformance (the subset the generator emits) ───────

function conforms(schema: any, v: unknown): boolean {
  if (schema.anyOf) return schema.anyOf.some((s: unknown) => conforms(s, v));
  if ("const" in schema) return v === schema.const;
  switch (schema.type) {
    case "string": return typeof v === "string" && (!schema.enum || schema.enum.includes(v)) && (schema.maxLength === undefined || v.length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern).test(v));
    case "number": return typeof v === "number";
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v) && (schema.maxItems === undefined || v.length <= schema.maxItems) && v.every((x) => conforms(schema.items, x));
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      if ((schema.required ?? []).some((k: string) => !(k in o))) return false;
      return Object.entries(o).every(([k, x]) => (schema.properties?.[k] ? conforms(schema.properties[k], x) : schema.additionalProperties === true));
    }
  }
  return false;
}

async function main(): Promise<void> {
  // ── M. LlamaServerModel ───────────────────────────────────────────────────
  console.log("\n[M] LlamaServerModel against a fake local server");
  const fake = await fakeServer((req, _b, res) => authorised(req) ? json(res, 200, completion({ ok: 1 })) : json(res, 401, { error: { message: "Invalid API Key" } }));
  const model = new LlamaServerModel({ endpoint: { baseUrl: fake.url, apiKey: KEY } });

  {
    const out = await model.generateJson(planReq(never, { schema: { type: "object", properties: { ok: { type: "integer" } } } }));
    check(JSON.stringify(out) === '{"ok":1}', "M1 successful generation returns the parsed JSON", out);
    const sent = JSON.parse(fake.requests.at(-1)!.body);
    check(fake.requests.at(-1)!.url === "/v1/chat/completions", "M1 calls /v1/chat/completions");
    check(fake.requests.at(-1)!.headers.authorization === `Bearer ${KEY}`, "M1 sends the per-launch key as a bearer token");
    check(sent.response_format?.type === "json_schema" && sent.response_format.json_schema.schema.properties.ok.type === "integer", "M1 forwards the schema as response_format.json_schema", sent.response_format);
    check(sent.max_tokens === 768 && sent.stream === false && sent.temperature === 0, "M1 default plan token cap 768, non-streaming, temperature 0", { max: sent.max_tokens });
    check(sent.messages[0].role === "system" && sent.messages[1].content === "usr", "M1 system + user messages");
  }
  {
    await model.generateJson({ purpose: "assess", system: "s", user: "u", signal: never });
    const sent = JSON.parse(fake.requests.at(-1)!.body);
    check(sent.max_tokens === 256 && sent.response_format.type === "json_object", "M2 assess cap 256; no schema → json_object mode", sent.response_format);
    const capped = new LlamaServerModel({ endpoint: { baseUrl: fake.url, apiKey: KEY }, maxTokens: { plan: 99 } });
    await capped.generateJson(planReq());
    check(JSON.parse(fake.requests.at(-1)!.body).max_tokens === 99, "M2 output limit is configurable");
    await capped.generateJson(planReq(never, { maxTokens: 7 }));
    check(JSON.parse(fake.requests.at(-1)!.body).max_tokens === 7, "M2 per-request maxTokens overrides the default");
  }

  fake.setHandler((_q, _b, res) => json(res, 200, completion("this is not json")));
  check(kindOf(await expectError(model.generateJson(planReq()))) === "malformed", "M3 non-JSON model output → malformed");
  fake.setHandler((_q, _b, res) => { res.writeHead(200); res.end("<html>"); });
  check(kindOf(await expectError(model.generateJson(planReq()))) === "malformed", "M3 non-JSON response envelope → malformed");
  fake.setHandler((_q, _b, res) => json(res, 200, { choices: [] }));
  check(kindOf(await expectError(model.generateJson(planReq()))) === "malformed", "M3 envelope without content → malformed");
  fake.setHandler((_q, _b, res) => json(res, 200, completion('{"intent":"ta', "length")));
  check(kindOf(await expectError(model.generateJson(planReq()))) === "truncated", "M3 finish_reason=length → truncated (not parsed as a partial plan)");

  fake.setHandler((_q, _b, res) => json(res, 500, { error: { message: "boom" } }));
  const e500 = await expectError(model.generateJson(planReq()));
  check(kindOf(e500) === "http" && /HTTP 500/.test(e500!.message), "M4 HTTP 500 → http error", e500?.message);
  fake.setHandler((_q, _b, res) => json(res, 503, { error: { message: "Loading model" } }));
  check(kindOf(await expectError(model.generateJson(planReq()))) === "unavailable", "M4 HTTP 503 → unavailable");

  {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const dead = new LlamaServerModel({ endpoint: { baseUrl: `http://127.0.0.1:${deadPort}`, apiKey: KEY } });
    const e = await expectError(dead.generateJson(planReq()));
    check(kindOf(e) === "unavailable" && /ECONNREFUSED/.test(e!.message), "M5 connection refused → unavailable", e?.message);
  }

  {
    fake.setHandler(() => { /* never answers */ });
    const before = fake.closedEarly;
    const slow = new LlamaServerModel({ endpoint: { baseUrl: fake.url, apiKey: KEY }, requestTimeoutMs: 200 });
    const t0 = Date.now();
    const e = await expectError(slow.generateJson(planReq()));
    const took = Date.now() - t0;
    await sleep(100);
    check(kindOf(e) === "timeout" && took < 1_000, "M6 timeout → timeout error near the limit", { took, msg: e?.message });
    check(fake.closedEarly > before, "M6 timeout closes the HTTP connection (server-side generation can stop)");
  }

  {
    const before = fake.closedEarly;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const e = await expectError(model.generateJson(planReq(ac.signal)));
    await sleep(100);
    check(kindOf(e) === "cancelled" && Date.now() - t0 < 1_000, "M7 caller cancellation → cancelled promptly", e?.message);
    check(fake.closedEarly > before, "M7 cancellation closes the HTTP connection");
    const pre = new AbortController(); pre.abort();
    const n = fake.requests.length;
    check(kindOf(await expectError(model.generateJson(planReq(pre.signal)))) === "cancelled" && fake.requests.length === n, "M7 already-aborted signal → no request sent");
  }

  {
    fake.setHandler((req, _b, res) => authorised(req) ? json(res, 200, completion({})) : json(res, 401, { error: { message: `Invalid API Key` } }));
    const wrong = new LlamaServerModel({ endpoint: { baseUrl: fake.url, apiKey: "wrong-key-123456" } });
    const e = await expectError(wrong.generateJson(planReq()));
    check(kindOf(e) === "auth", "M8 incorrect API key → auth error", e?.message);
    check(!e!.message.includes("wrong-key-123456"), "M8 the key never appears in the error");
    fake.setHandler((_q, _b, res) => json(res, 400, { error: { message: `bad request for key ${KEY}` } }));
    const e2 = await expectError(model.generateJson(planReq()));
    check(kindOf(e2) === "http" && !e2!.message.includes(KEY) && e2!.message.includes("[redacted]"), "M8 a server echo of the key is redacted", e2?.message);
  }

  {
    fake.setHandler((_q, _b, res) => { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(10 * 1024 * 1024) }); res.write("{"); });
    const small = new LlamaServerModel({ endpoint: { baseUrl: fake.url, apiKey: KEY }, maxResponseBytes: 64 * 1024 });
    check(kindOf(await expectError(small.generateJson(planReq()))) === "oversized", "M9 declared oversized response → oversized");
    fake.setHandler((_q, _b, res) => { res.writeHead(200, { "Content-Type": "application/json" }); const chunk = "x".repeat(16 * 1024); let i = 0; const t = setInterval(() => { if (res.destroyed || i++ > 100) { clearInterval(t); res.end(); } else res.write(chunk); }, 1); });
    const e = await expectError(small.generateJson(planReq()));
    check(kindOf(e) === "oversized", "M9 streamed (chunked) oversized response → oversized, read stops at the cap", e?.message);
  }

  {
    const n = fake.requests.length;
    const bad = ["http://192.168.1.10:8080", "http://localhost:8080", "https://127.0.0.1:8443", "http://127.0.0.1.nip.io:80", "http://user:pw@127.0.0.1:9000",
      `${fake.url}/v1`, "http://127.0.0.1", "http://[::ffff:7f00:1]:80", "http://0.0.0.0:8080", "ftp://127.0.0.1:21", "http://10.0.0.1:80?x=1"];
    for (const baseUrl of bad) {
      const m = new LlamaServerModel({ endpoint: { baseUrl, apiKey: KEY } });
      check(kindOf(await expectError(m.generateJson(planReq()))) === "endpoint", `M10 rejects non-loopback/ambiguous endpoint ${baseUrl}`);
    }
    check(fake.requests.length === n, "M10 no request was sent to any rejected endpoint");
    check(assertLoopbackBaseUrl("http://127.0.0.1:9000") === "http://127.0.0.1:9000" && assertLoopbackBaseUrl("http://[::1]:9000") === "http://[::1]:9000" && assertLoopbackBaseUrl("http://127.5.6.7:1") === "http://127.5.6.7:1", "M10 accepts 127.0.0.0/8 and [::1] with a port");
    fake.setHandler((_q, _b, res) => { res.writeHead(302, { Location: "http://203.0.113.9:80/v1/chat/completions" }); res.end(); });
    const e = await expectError(model.generateJson(planReq()));
    check(kindOf(e) === "unavailable" && fake.requests.at(-1)!.url === "/v1/chat/completions", "M10 a redirect off loopback is refused, not followed", e?.message);
  }

  {
    let calls = 0;
    const provided = new LlamaServerModel({ endpoint: async () => { calls++; return { baseUrl: fake.url, apiKey: KEY, release: () => calls++ }; } });
    fake.setHandler((_q, _b, res) => json(res, 200, completion({ a: 1 })));
    await provided.generateJson(planReq());
    check(calls === 2, "M11 endpoint provider acquired once and released once per request");
    const stopping = new AbortController();
    fake.setHandler(() => { /* hang */ });
    const viaStop = new LlamaServerModel({ endpoint: async () => ({ baseUrl: fake.url, apiKey: KEY, signal: stopping.signal }) });
    setTimeout(() => stopping.abort(), 100);
    check(kindOf(await expectError(viaStop.generateJson(planReq()))) === "unavailable", "M11 server stop aborts in-flight requests as unavailable");
  }
  await fake.close();

  // ── S. Schema generation ─────────────────────────────────────────────────
  console.log("\n[S] Model-facing schemas generated from registered tools");
  const registry = createDefaultRegistry(ROOT);
  const usable = registry.listUsable(DEFAULT_GRANTS);
  const planSchema = buildPlanSchema(usable, 8) as any;
  const variants = planSchema.properties.steps.items.anyOf as any[];
  check(variants.length === usable.length && variants.every((v, i) => v.properties.tool.const === usable[i].name), "S1 one step variant per usable tool, keyed by const tool name", variants.map((v) => v.properties.tool.const));
  check(variants.every((v, i) => JSON.stringify(v.properties.input) === JSON.stringify(toModelSchema(usable[i].inputSchema))), "S1 each variant's input is that tool's input schema");
  check(variants.every((v) => v.additionalProperties === false && v.properties.input.additionalProperties === false) && planSchema.additionalProperties === false, "S1 no additional properties anywhere");
  check(planSchema.properties.steps.maxItems === 8, "S1 step count bounded by maxSteps");
  const goodPlan = { intent: "task", goal: "g", successCriteria: ["c"], steps: [{ id: "s1", description: "time", tool: "system.time", input: {} }, { id: "s2", description: "calc", tool: "math.evaluate", input: { expression: "1+1" } }] };
  check(conforms(planSchema, goodPlan), "S2 a valid plan conforms to the generated schema");
  check(!conforms(planSchema, { ...goodPlan, steps: [{ ...goodPlan.steps[0], dependsOn: [] }] }), "S2 dependsOn is not part of the model-facing schema (the runtime generates dependencies)");
  check(!conforms(planSchema, { ...goodPlan, steps: [{ ...goodPlan.steps[0], tool: "shell.exec" }] }), "S2 an unregistered tool does not conform");
  check(!conforms(planSchema, { ...goodPlan, steps: [{ ...goodPlan.steps[1], input: { expression: "1", extra: 1 } }] }), "S2 extra input properties do not conform");
  check(!conforms(planSchema, { ...goodPlan, steps: [{ ...goodPlan.steps[0], id: "step-1" }] }), "S2 ids outside s<n> do not conform");
  const empty = buildPlanSchema([], 8) as any;
  check(empty.properties.steps.maxItems === 0 && conforms(empty, { intent: "unsupported", goal: "g", successCriteria: [], steps: [], refusalReason: "r" }), "S3 no tools → only an empty step list fits");
  const one = buildPlanSchema(usable.slice(0, 1), 8) as any;
  check(one.properties.steps.items.properties.tool.const === usable[0].name, "S3 single tool → plain object (no anyOf)");
  const withPattern = toModelSchema({ type: "object", properties: { p: { type: "string", pattern: "^a+$", maxLength: 5 } }, required: ["p"] }) as any;
  check(withPattern.properties.p.pattern === undefined && withPattern.properties.p.maxLength === 5, "S4 tool-input regex patterns are not forwarded (planner still enforces them)");
  check(conforms(ASSESSMENT_OUTPUT_SCHEMA, { criteriaSatisfied: false, missing: ["x"], needsMoreSteps: false, reason: "r" }), "S5 assessment schema accepts a well-formed assessment");

  {
    const seen: StructuredRequest[] = [];
    const capture: LanguageModel = { name: "capture", async generateJson(r) { seen.push(r); return r.purpose === "plan" ? goodPlan : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "r" }; } };
    const brain = new Brain(capture, 5_000);
    await brain.proposePlan({ objective: "o", tools: usable, history: [], maxSteps: 5 }, never);
    await brain.assessCompletion({ objective: "o", successCriteria: [], evidence: [] }, never);
    check(JSON.stringify(seen[0].schema) === JSON.stringify(buildPlanSchema(usable, 5)), "S6 Brain attaches the generated plan schema");
    check(seen[1].schema === ASSESSMENT_OUTPUT_SCHEMA, "S6 Brain attaches the assessment schema");
  }

  // ── V. Independent validation of schema-valid output ─────────────────────
  console.log("\n[V] Schema-valid output is still validated independently");
  {
    // A registered tool the runtime does NOT grant. A schema built from ALL registered
    // tools would admit it; the planner must still refuse it.
    let netRan = false;
    const netTool: ToolSpec = {
      name: "net.fetch", description: "fetch a URL", inputSchema: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"] },
      permissions: ["network"], risk: "medium", requiresApproval: false, timeoutMs: 1_000,
      async execute() { netRan = true; return { ok: true, evidence: "fetched" }; },
    };
    const reg = createDefaultRegistry(ROOT).register(netTool);
    const allTools = reg.list();
    const fullSchema = buildPlanSchema(allTools, 8);
    const unauthorised = { intent: "task", goal: "g", successCriteria: ["c"], steps: [{ id: "s1", description: "fetch", tool: "net.fetch", input: { url: "http://example.com" } }] };
    check(conforms(fullSchema, unauthorised), "V1 precondition: the unauthorised plan conforms to a schema of all registered tools");
    check(!(buildPlanSchema(reg.listUsable(DEFAULT_GRANTS), 8) as any).properties.steps.items.anyOf.some((v: any) => v.properties.tool.const === "net.fetch"), "V1 the schema actually sent only offers granted tools");

    const fakeLlm = await fakeServer((_q, body, res) => {
      const purpose = JSON.parse(body).response_format?.json_schema?.name;
      json(res, 200, completion(purpose === "plan" ? unauthorised : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "all good" }));
    });
    const llm = new LlamaServerModel({ endpoint: { baseUrl: fakeLlm.url, apiKey: KEY } });
    const rt = new AgentRuntime({ model: llm, registry: reg, granted: DEFAULT_GRANTS });
    const report = await rt.run({ taskId: "v1", objective: "fetch example.com" });
    check(report.outcome === "failed" && !netRan && /not permitted/.test(report.error ?? ""), "V1 schema-valid but unauthorised plan → refused by the planner, tool never runs", { outcome: report.outcome, error: report.error });

    const planner = new Planner(new Brain(llm, 5_000), reg);
    const pc = (steps: unknown[]) => planner.check({ intent: "task", goal: "g", successCriteria: [], steps }, { maxSteps: 8, granted: DEFAULT_GRANTS });
    const forward = pc([{ id: "s1", description: "a", tool: "system.time", input: {}, dependsOn: ["s2"] }, { id: "s2", description: "b", tool: "system.info", input: {}, dependsOn: [] }]);
    // The model-facing schema no longer offers dependsOn; an unconstrained model can still send it, and the planner rejects bad ones.
    check(!forward.ok && !conforms(planSchema, { intent: "task", goal: "g", successCriteria: [], steps: [{ id: "s1", description: "a", tool: "system.time", input: {}, dependsOn: ["s2"] }] }), "V2 forward dependency: not expressible in the schema, and rejected by the planner if sent anyway");
    const dup = pc([{ id: "s1", description: "a", tool: "system.time", input: {}, dependsOn: [] }, { id: "s1", description: "b", tool: "system.info", input: {}, dependsOn: [] }]);
    check(!dup.ok && (dup as { errors: string[] }).errors.some((e) => /duplicate/.test(e)), "V3 schema-valid duplicate step ids → rejected");
    const dangling = pc([{ id: "s1", description: "a", tool: "system.time", input: {}, dependsOn: ["s9"] }]);
    check(!dangling.ok, "V4 schema-valid dependency on a non-existent step → rejected");
    const tooMany = pc(Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, description: "t", tool: "system.time", input: {}, dependsOn: [] })));
    check(!tooMany.ok, "V5 more steps than the runtime limit → rejected even if a schema allowed it");
    const patterned = new ToolRegistry().register({ name: "p.tool", description: "d", inputSchema: { type: "object", properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } }, required: ["code"] }, permissions: ["compute"], risk: "low", requiresApproval: false, timeoutMs: 100, async execute() { return { ok: true, evidence: "e" }; } });
    const pp = new Planner(new Brain(llm, 5_000), patterned).check({ intent: "task", goal: "g", successCriteria: [], steps: [{ id: "s1", description: "x", tool: "p.tool", input: { code: "abc" }, dependsOn: [] }] }, { maxSteps: 8, granted: DEFAULT_GRANTS });
    check(!pp.ok, "V6 input that passes the (pattern-free) model schema but breaks the tool's pattern → rejected");

    // Verifier: a model claiming success cannot upgrade a failed step.
    const failing: ToolSpec = { name: "test.fail", description: "always fails", inputSchema: { type: "object", properties: {} }, permissions: ["compute"], risk: "low", requiresApproval: false, timeoutMs: 1_000, async execute() { return { ok: false, error: "disk unavailable", evidence: "" }; } };
    const regF = createDefaultRegistry(ROOT).register(failing);
    fakeLlm.setHandler((_q, body, res) => {
      const purpose = JSON.parse(body).response_format?.json_schema?.name;
      json(res, 200, completion(purpose === "plan"
        ? { intent: "task", goal: "g", successCriteria: ["both done"], steps: [{ id: "s1", description: "time", tool: "system.time", input: {}, dependsOn: [] }, { id: "s2", description: "fail", tool: "test.fail", input: {}, dependsOn: [] }] }
        : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "Everything succeeded perfectly." }));
    });
    const rF = await new AgentRuntime({ model: llm, registry: regF, granted: DEFAULT_GRANTS, limits: { maxIterations: 1 } }).run({ taskId: "v7", objective: "do both" });
    check(rF.outcome === "partial" && rF.steps[1].status === "failed", "V7 injected tool failure + model claims success → partial, never completed", { outcome: rF.outcome });

    fakeLlm.setHandler((_q, body, res) => {
      const purpose = JSON.parse(body).response_format?.json_schema?.name;
      json(res, 200, completion(purpose === "plan" ? goodPlan : "garbage-not-json"));
    });
    const rU = await new AgentRuntime({ model: llm, registry: createDefaultRegistry(ROOT), granted: DEFAULT_GRANTS, limits: { maxIterations: 1 } }).run({ taskId: "v8", objective: "time and 1+1" });
    check(rU.outcome === "unverified" && rU.steps.every((s) => s.status === "succeeded"), "V8 steps succeed but the assessment is malformed → unverified (capped)", { outcome: rU.outcome });

    fakeLlm.setHandler((_q, body, res) => {
      const purpose = JSON.parse(body).response_format?.json_schema?.name;
      json(res, 200, completion(purpose === "plan" ? goodPlan : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" }));
    });
    const rOk = await new AgentRuntime({ model: llm, registry: createDefaultRegistry(ROOT), granted: DEFAULT_GRANTS }).run({ taskId: "v9", objective: "time and 1+1" });
    check(rOk.outcome === "completed" && rOk.steps.every((s) => s.outcome?.evidence), "V9 end-to-end through the local adapter: real tools run, evidence recorded, completed", { outcome: rOk.outcome, response: rOk.response });
    await fakeLlm.close();
  }

  // ── U. InferenceSupervisor with a fake server process ────────────────────
  console.log("\n[U] InferenceSupervisor (fake llama-server process)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dask-sup-"));
  const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  fs.mkdirSync(path.join(tmp, "rt"));
  fs.mkdirSync(path.join(tmp, "models"));
  fs.writeFileSync(path.join(tmp, "rt", "llama-server.exe"), "fake executable bytes");
  fs.writeFileSync(path.join(tmp, "rt", "ggml.dll"), "fake dll bytes");
  fs.writeFileSync(path.join(tmp, "models", "m.gguf"), "fake model bytes");
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    runtime: { id: "fake", version: "0", commit: "0", os: "windows", arch: "x64", variant: "vulkan", source: "n/a", archiveSha256: "n/a", installDir: "rt", executable: "llama-server.exe",
      files: { "llama-server.exe": sha(path.join(tmp, "rt", "llama-server.exe")), "ggml.dll": sha(path.join(tmp, "rt", "ggml.dll")) } },
    models: [{ id: "m", file: "models/m.gguf", sizeBytes: fs.statSync(path.join(tmp, "models", "m.gguf")).size, sha256: sha(path.join(tmp, "models", "m.gguf")), architecture: { nLayer: 2, nKvHead: 1, headDim: 8, nVocab: 100 }, defaultContext: 512 }],
  };
  const plenty = () => ({ availableBytes: 64 * 1024 ** 3, totalBytes: 128 * 1024 ** 3 });
  const fixture = path.join(__dirname, "fixtures", "fake-llama-server.mjs");
  const launches: { args: string[]; started?: any }[] = [];
  const launcher = (fakeEnv: Record<string, string> = {}): Launcher => (_file, args, env) => {
    const rec: { args: string[]; started?: any } = { args };
    launches.push(rec);
    const child = spawn(process.execPath, [fixture, ...args], { env: { ...env, ...fakeEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout!.once("data", (d: Buffer) => { try { rec.started = JSON.parse(d.toString().split("\n")[0]); } catch { /* ignore */ } });
    return child;
  };
  const mkSup = (opts: Partial<ConstructorParameters<typeof InferenceSupervisor>[0]> = {}, fakeEnv: Record<string, string> = {}) =>
    new InferenceSupervisor({ root: tmp, manifest, modelId: "m", memoryProbe: plenty, launcher: launcher(fakeEnv), restartBackoffMs: 50, readyTimeoutMs: 10_000, idleUnloadMs: 0, ...opts });
  const procAlive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

  const prevLlama = process.env.LLAMA_ARG_N_GPU_LAYERS;
  process.env.LLAMA_ARG_N_GPU_LAYERS = "77";
  process.env.HF_TOKEN_TEST_ONLY = "should-not-leak";

  try {
    {
      const n = launches.length;
      const badManifest: ArtifactManifest = { ...manifest, runtime: { ...manifest.runtime, files: { ...manifest.runtime.files, "ggml.dll": "0".repeat(64) } } };
      const s = new InferenceSupervisor({ root: tmp, manifest: badManifest, modelId: "m", memoryProbe: plenty, launcher: launcher() });
      const e = await expectError(s.start());
      check(s.status().state === "failed" && launches.length === n && /runtime verification failed/.test(e?.message ?? ""), "U1 runtime file hash mismatch → failed, nothing launched", e?.message);
      const badModel: ArtifactManifest = { ...manifest, models: [{ ...manifest.models[0], sha256: "f".repeat(64) }] };
      const s2 = new InferenceSupervisor({ root: tmp, manifest: badModel, modelId: "m", memoryProbe: plenty, launcher: launcher() });
      const e2 = await expectError(s2.start());
      check(s2.status().state === "failed" && launches.length === n && /model verification failed/.test(e2?.message ?? ""), "U2 model hash mismatch → failed, nothing launched", e2?.message);
      const unpinnedExe: ArtifactManifest = { ...manifest, runtime: { ...manifest.runtime, files: { "ggml.dll": manifest.runtime.files["ggml.dll"] } } };
      const s3 = new InferenceSupervisor({ root: tmp, manifest: unpinnedExe, modelId: "m", memoryProbe: plenty, launcher: launcher() });
      await expectError(s3.start());
      check(s3.status().state === "failed" && launches.length === n, "U2 an executable that is not pinned in the manifest → failed");
    }

    {
      const n = launches.length;
      const s = mkSup({ memoryProbe: () => ({ availableBytes: 1024 ** 3, totalBytes: 8 * 1024 ** 3 }) });
      const e = await expectError(s.start());
      check(s.status().state === "failed" && launches.length === n && /Insufficient physical memory/.test(e?.message ?? ""), "U3 insufficient memory → failed before launch", e?.message);
      const est = s.status().memoryEstimate;
      check(est.totalBytes === est.weightsBytes + est.kvCacheBytes + est.computeBytes + est.overheadBytes && est.kvCacheBytes > 0 && est.computeBytes > 0 && est.overheadBytes > 0, "U3 requirement counts weights + KV cache + compute + overhead, not file size alone", est);
      let threw = false;
      try { mkSup({ minHeadroomMB: 500 }); } catch (err) { threw = err instanceof SupervisorFatalError; }
      check(threw, "U3 the 2000 MB headroom cannot be lowered");
    }

    {
      const states: string[] = [];
      const s = mkSup({ onStatus: (st) => { if (states.at(-1) !== st.state) states.push(st.state); } }, { FAKE_LOAD_MS: "300" });
      const llm = new LlamaServerModel({ endpoint: s.endpoint });
      const out = await llm.generateJson({ purpose: "plan", system: "s", user: "u", signal: never, schema: { type: "object" } }) as { steps: unknown[] };
      const st = s.status();
      const rec = launches.at(-1)!;
      check(Array.isArray(out.steps) && st.state === "ready" && states.join(">") === "loading>ready", "U4 on-demand start: loading → ready, request served", states);
      check(rec.started?.host === "127.0.0.1" && rec.args.includes("--offline") && rec.args.includes("--no-webui"), "U4 launched on 127.0.0.1 with --offline and --no-webui", rec.args);
      check(rec.started?.hasKey === true && rec.started?.keyInArgs === false, "U4 per-launch API key passed via environment, not argv");
      check(Array.isArray(rec.started?.leakedEnv) && rec.started.leakedEnv.length === 0, "U4 inherited LLAMA_*/HF_* variables are stripped", rec.started?.leakedEnv);
      check(rec.args.includes("--device") && rec.args[rec.args.indexOf("--device") + 1] === "Vulkan0" && st.backend === "vulkan", "U4 auto backend prefers Vulkan");
      const statusJson = JSON.stringify(st) + s.logTail(200).join("\n");
      check(!/LLAMA_API_KEY|Bearer /.test(statusJson) && st.port !== null, "U4 status and logs carry no credential");
      const firstPort = st.port;
      await s.stop("test");
      check(s.status().state === "unavailable" && !procAlive(st.pid), "U4 stop → unavailable, process gone");
      await llm.generateJson({ purpose: "assess", system: "s", user: "u", signal: never });
      check(s.status().state === "ready" && s.status().port !== firstPort, "U4 restart after stop gets a fresh port (and key)");
      await s.stop("test");
    }

    {
      const s = mkSup({}, { FAKE_FAIL_ON_VULKAN: "1" });
      await s.start();
      const st = s.status();
      check(st.state === "degraded" && st.backend === "cpu" && /Vulkan launch failed/.test(st.fallbackReason ?? ""), "U5 Vulkan launch failure → CPU fallback, state degraded", st);
      check(launches.at(-1)!.args.join(" ").includes("--device none --n-gpu-layers 0"), "U5 CPU fallback disables GPU offload");
      await s.stop("test");
    }

    {
      const s = mkSup({}, { FAKE_NO_AUTH: "1" });
      const e = await expectError(s.start());
      check(s.status().state === "failed" && /did not reject an unauthenticated request/.test(e?.message ?? "") && !procAlive(launches.length ? s.status().pid : null), "U6 a server that does not enforce the API key is refused (fail closed)", e?.message);
    }

    {
      const marker = path.join(tmp, "crash-once");
      const s = mkSup({}, { FAKE_CRASH_AFTER_MS: "400", FAKE_CRASH_ONCE_FILE: marker });
      await s.start();
      const pid1 = s.status().pid;
      for (let i = 0; i < 100 && (s.status().pid === pid1 || s.status().state !== "ready"); i++) await sleep(50);
      const st = s.status();
      check(st.state === "ready" && st.restarts === 1 && st.pid !== pid1 && !procAlive(pid1), "U7 crash while ready → automatic restart (restarts=1)", st);
      await s.stop("test");
    }

    {
      const s = mkSup({ maxRestarts: 2 }, { FAKE_CRASH_AFTER_MS: "150" });
      await s.start().catch(() => {});
      for (let i = 0; i < 200 && s.status().state !== "failed"; i++) await sleep(50);
      check(s.status().state === "failed" && s.status().restarts === 3, "U8 repeated crashes → failed after maxRestarts (bounded)", s.status());
      const e = await expectError(s.start());
      check(kindOf(e) === "unavailable", "U8 failed supervisor refuses requests until reset()");
      s.reset();
      check(s.status().state === "unavailable", "U8 reset() clears the failed state");
    }

    {
      const s = mkSup({ idleUnloadMs: 300 });
      const llm = new LlamaServerModel({ endpoint: s.endpoint });
      await llm.generateJson({ purpose: "assess", system: "s", user: "u", signal: never });
      const pid = s.status().pid;
      await sleep(700);
      check(s.status().state === "unavailable" && !procAlive(pid), "U9 idle unload stops the server after the idle delay", s.status().state);
      await llm.generateJson({ purpose: "assess", system: "s", user: "u", signal: never });
      check(s.status().state === "ready", "U9 next request reloads on demand");
      await s.stop("test");
    }

    {
      const s = mkSup({}, { FAKE_LOAD_MS: "8000" });
      const starting = s.start().catch((e) => e);
      for (let i = 0; i < 100 && !s.status().pid; i++) await sleep(20);
      const pid = s.status().pid;
      const t0 = Date.now();
      await s.stop("emergency");
      const took = Date.now() - t0;
      const err = await starting;
      check(took < 1_500 && s.status().state === "unavailable" && !procAlive(pid), "U10 stop during model load cancels the start promptly and kills the process", { took });
      check(kindOf(err) === "unavailable", "U10 the pending start reports the cancellation", String(err));
    }

    {
      const s = mkSup({}, { FAKE_HOLD_MS: "10000" });
      const llm = new LlamaServerModel({ endpoint: s.endpoint, requestTimeoutMs: 30_000 });
      await s.start();
      const pending = expectError(llm.generateJson({ purpose: "plan", system: "s", user: "u", signal: never }));
      await sleep(200);
      const t0 = Date.now();
      await s.stop("shutdown");
      const e = await pending;
      check(kindOf(e) === "unavailable" && Date.now() - t0 < 1_500, "U11 shutdown aborts in-flight requests and terminates", e?.message);
    }

    {
      const s = mkSup({}, { FAKE_EXIT_IMMEDIATELY: "1" });
      const t0 = Date.now();
      const e = await expectError(s.start());
      check(s.status().state === "failed" && s.status().backend === null && Date.now() - t0 < 5_000, "U12 a server that never starts → bounded retries (Vulkan, CPU, then backoff) → failed", { msg: e?.message, restarts: s.status().restarts });
    }
  } finally {
    if (prevLlama === undefined) delete process.env.LLAMA_ARG_N_GPU_LAYERS; else process.env.LLAMA_ARG_N_GPU_LAYERS = prevLlama;
    delete process.env.HF_TOKEN_TEST_ONLY;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// main() ends with process.exit(); reaching beforeExit means a promise was stranded.
process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
