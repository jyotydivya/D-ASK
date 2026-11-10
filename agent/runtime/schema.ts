// ─────────────────────────────────────────────────────────────────────────────
// Minimal JSON-schema-subset validator (no dependencies).
// Fail-closed: unknown properties are rejected unless additionalProperties is true.
// ─────────────────────────────────────────────────────────────────────────────

import type { JsonSchema } from "./types";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validate(schema: JsonSchema, value: unknown, path = "input"): ValidationResult {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") { errors.push(`${path}: expected string`); return; }
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match the required pattern`);
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) { errors.push(`${path}: expected finite number`); return; }
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
    case "array": {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) { errors.push(`${path}: expected object`); return; }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties[key];
        if (prop === undefined) {
          if (schema.additionalProperties !== true) errors.push(`${path}.${key}: unknown property`);
          continue;
        }
        if (v !== undefined) check(prop, v, `${path}.${key}`, errors);
      }
      return;
    }
  }
}
