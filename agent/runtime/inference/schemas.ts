// ─────────────────────────────────────────────────────────────────────────────
// Model-facing output schemas, generated from the registered tool definitions.
//
// These narrow what a local model can emit (llama-server turns them into a
// grammar). They are a convenience, not a security boundary: every plan is still
// checked by Planner.check() (registration, permissions, input schema, ids,
// dependencies) and every assessment by the Verifier's own schema.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArgumentDomain, JsonSchema, ModelOutputSchema, ToolDescriptor } from "../types";

/** tool name → property → request-derived domain (see grounding.ts). */
export type ArgumentDomains = Record<string, Record<string, ArgumentDomain>>;

/** Step ids the model may use. A strict subset of what Planner.check() accepts. */
export const MODEL_STEP_ID_PATTERN = "^s[0-9]{1,2}$";

/**
 * Convert a tool's input schema (the runtime's JSON-schema subset) to standard
 * JSON Schema. `pattern` is deliberately dropped: grammar converters support only
 * part of regex syntax, and the planner re-validates the full schema anyway.
 */
export function toModelSchema(schema: JsonSchema): Record<string, unknown> {
  switch (schema.type) {
    case "string": {
      const out: Record<string, unknown> = { type: "string" };
      if (schema.enum) out.enum = [...schema.enum];
      if (schema.minLength !== undefined) out.minLength = schema.minLength;
      if (schema.maxLength !== undefined) out.maxLength = schema.maxLength;
      return out;
    }
    case "number":
    case "integer": {
      const out: Record<string, unknown> = { type: schema.type };
      if (schema.minimum !== undefined) out.minimum = schema.minimum;
      if (schema.maximum !== undefined) out.maximum = schema.maximum;
      return out;
    }
    case "boolean":
      return { type: "boolean" };
    case "array": {
      const out: Record<string, unknown> = { type: "array", items: toModelSchema(schema.items) };
      if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
      return out;
    }
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toModelSchema(v)])),
        required: [...(schema.required ?? [])],
        additionalProperties: schema.additionalProperties === true,
      };
  }
}

/** Narrow a tool's input schema with request-derived domains (enum / forbidden). */
export function applyDomains(input: Record<string, unknown>, domains: Record<string, ArgumentDomain> | undefined): Record<string, unknown> {
  if (!domains) return input;
  const properties = { ...(input.properties as Record<string, Record<string, unknown>>) };
  const required = new Set<string>((input.required as string[]) ?? []);
  for (const [prop, dom] of Object.entries(domains)) {
    if (!(prop in properties)) continue;
    if (dom.kind === "forbidden") {
      delete properties[prop];
      required.delete(prop);
    } else {
      properties[prop] = { type: "string", enum: [...dom.values] };
      if (!dom.optional) required.add(prop);
    }
  }
  return { ...input, properties, required: [...required] };
}

/**
 * One step variant per tool. There is deliberately no `dependsOn`: steps run in
 * the order given and the runtime generates the (sequential) dependencies itself.
 */
function stepSchema(tool: ToolDescriptor, domains?: ArgumentDomains): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "description", "tool", "input"],
    properties: {
      id: { type: "string", pattern: MODEL_STEP_ID_PATTERN },
      description: { type: "string", maxLength: 200 },
      tool: { const: tool.name },
      input: applyDomains(toModelSchema(tool.inputSchema), domains?.[tool.name]),
    },
  };
}

/**
 * Plan schema: one step variant per usable tool, keyed by a `const` tool name, so
 * a constrained model can only name tools that were offered, only with inputs
 * shaped like that tool's schema, and (where the request determines them) only
 * with argument values taken from the request. With no tools, only an empty
 * step list fits.
 */
export function buildPlanSchema(tools: readonly ToolDescriptor[], maxSteps: number, domains?: ArgumentDomains): ModelOutputSchema {
  const steps: Record<string, unknown> = tools.length === 0
    ? { type: "array", maxItems: 0, items: { type: "object", properties: {}, additionalProperties: false } }
    : {
        type: "array",
        maxItems: maxSteps,
        items: tools.length === 1 ? stepSchema(tools[0], domains) : { anyOf: tools.map((t) => stepSchema(t, domains)) },
      };
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "goal", "successCriteria", "steps"],
    properties: {
      intent: { type: "string", enum: ["task", "question", "unsupported"] },
      goal: { type: "string", maxLength: 300 },
      successCriteria: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
      steps,
      refusalReason: { type: "string", maxLength: 500 },
    },
  };
}

export const ASSESSMENT_OUTPUT_SCHEMA: ModelOutputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["criteriaSatisfied", "missing", "needsMoreSteps", "reason"],
  properties: {
    criteriaSatisfied: { type: "boolean" },
    missing: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    needsMoreSteps: { type: "boolean" },
    reason: { type: "string", maxLength: 500 },
  },
});

/** Output token caps per purpose (configurable through LlamaServerModel options). */
export const DEFAULT_MAX_TOKENS = Object.freeze({ plan: 768, assess: 256 });
