// ─────────────────────────────────────────────────────────────────────────────
// Verifier — decides success from evidence.
//
// Invariants:
//   - A step succeeds only if the tool actually executed, reported ok, produced
//     non-empty evidence, and passed the tool's own postcondition (if any).
//   - The model is consulted only about whether the OBSERVED evidence meets the
//     success criteria. It can downgrade a result, never upgrade one: a failed
//     step can never become "completed", and an unavailable or malformed
//     assessment yields "unverified", never "completed".
//   - "completed" additionally requires deterministic, model-independent
//     verification (grounding.ts): every step grounded in the request text and
//     every detected request facet covered by executed tool output.
// ─────────────────────────────────────────────────────────────────────────────

import type { Brain } from "./brain";
import { validate } from "./schema";
import type { InvokeResult } from "./toolRegistry";
import { errMessage, type ToolRegistry } from "./toolRegistry";
import { assessGrounding } from "./grounding";
import type { JsonSchema, Plan, RunOutcome, StepState, StepStatus, ToolSpec, VerificationReport } from "./types";

const ASSESSMENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["criteriaSatisfied", "needsMoreSteps"],
  properties: {
    criteriaSatisfied: { type: "boolean" },
    missing: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
    needsMoreSteps: { type: "boolean" },
    reason: { type: "string", maxLength: 500 },
  },
};

export function judgeStep(spec: ToolSpec<any, any> | undefined, input: Record<string, unknown>, result: InvokeResult): { status: StepStatus; error?: string } {
  if (result.status === "cancelled") return { status: "cancelled", error: result.outcome.error ?? "Cancelled" };
  if (result.status !== "executed") return { status: "failed", error: result.outcome.error ?? result.status };
  if (!result.outcome.ok) return { status: "failed", error: result.outcome.error ?? "Tool reported failure" };
  if (!result.outcome.evidence.trim()) return { status: "failed", error: "Tool reported success but returned no evidence" };
  if (spec?.check) {
    let verdict: { ok: boolean; reason?: string };
    try {
      verdict = spec.check(input, result.outcome);
    } catch (err) {
      verdict = { ok: false, reason: `postcondition threw: ${errMessage(err)}` };
    }
    if (!verdict.ok) return { status: "failed", error: `Postcondition failed: ${verdict.reason ?? "unspecified"}` };
  }
  return { status: "succeeded" };
}

export function evidenceLines(steps: StepState[]): string[] {
  return steps.map((s) => {
    const head = `[${s.step.id}] ${s.step.tool} (${s.step.description})`;
    switch (s.status) {
      case "succeeded": return `${head} → OK: ${s.outcome?.evidence ?? ""}`;
      case "failed": return `${head} → FAILED: ${s.error ?? "unknown error"}`;
      case "skipped": return `${head} → NOT RUN: ${s.error ?? "skipped"}`;
      case "cancelled": return `${head} → CANCELLED`;
      default: return `${head} → ${s.status.toUpperCase()}`;
    }
  });
}

export class Verifier {
  /**
   * gapFeedback (default true): deterministic gaps request another planning round.
   * false exists ONLY for research ablations. It never affects the outcome rule.
   */
  constructor(private readonly brain: Brain, private readonly registry: ToolRegistry, private readonly opts: { gapFeedback?: boolean } = {}) {}

  async assess(objective: string, plan: Plan, steps: StepState[], signal: AbortSignal): Promise<VerificationReport> {
    const succeeded = steps.filter((s) => s.status === "succeeded").length;
    // Deterministic, model-independent part first.
    const g = assessGrounding(this.registry, objective, steps);
    const report: VerificationReport = {
      stepsSucceeded: succeeded,
      stepsTotal: steps.length,
      criteriaSatisfied: null,
      needsMoreSteps: false,
      missing: [],
      method: "evidence-only",
      notes: [],
      grounding: g.grounding,
      facets: g.facets,
      unexplained: g.unexplained,
      independentlyVerified: g.independentlyVerified,
    };
    if (g.unexplained.length) report.notes.push(`Parts of the request no check accounts for: ${g.unexplained.join(", ")}.`);
    const contradicted = g.grounding.filter((x) => x.status === "contradicted");
    for (const c of contradicted) report.notes.push(`Step ${c.stepId} does not match the request: ${c.reason}`);
    if (g.facets.length === 0) report.notes.push("No part of the request could be checked deterministically; completion cannot be independently confirmed.");
    for (const x of g.grounding.filter((y) => y.status === "ungrounded")) report.notes.push(`Step ${x.stepId} is not independently tied to the request (${x.reason}).`);

    if (succeeded === 0) {
      report.criteriaSatisfied = false;
      report.notes.push("No step produced evidence; nothing can be confirmed.");
      return report;
    }
    const finish = () => {
      if (this.opts.gapFeedback !== false) addDeterministicGaps(report, g.uncovered, contradicted);
      // Always (independent of gapFeedback): later steps of an explicitly ordered request that were never attempted while
      // every executed step succeeded. The planner (a small local model) may plan only the first step of "X, then Y".
      else if (contradicted.length === 0) addDeterministicGaps(report, g.pendingOrdered, []);
      return report;
    };
    if (signal.aborted) {
      report.notes.push("Cancelled before the semantic check.");
      return report;
    }

    let raw: unknown;
    try {
      raw = await this.brain.assessCompletion({ objective, successCriteria: plan.successCriteria, evidence: evidenceLines(steps) }, signal);
    } catch (err) {
      report.notes.push(`Semantic check unavailable: ${errMessage(err)}`);
      return finish();
    }
    const shape = validate(ASSESSMENT_SCHEMA, raw, "assessment");
    if (!shape.ok) {
      report.notes.push(`Semantic check returned an invalid result (${shape.errors.slice(0, 3).join("; ")})`);
      return finish();
    }
    const a = raw as { criteriaSatisfied: boolean; missing?: string[]; needsMoreSteps: boolean; reason?: string };
    report.method = "evidence+model";
    report.criteriaSatisfied = a.criteriaSatisfied;
    report.needsMoreSteps = a.needsMoreSteps;
    report.missing = a.missing ?? [];
    if (a.reason) report.notes.push(`Model assessment (advisory): ${a.reason}`);
    return finish();
  }
}

/** Deterministic gaps (uncovered facets, contradicted steps) always count as missing and justify another round. */
function addDeterministicGaps(report: VerificationReport, uncovered: string[], contradicted: { stepId: string; reason: string }[]): void {
  const gaps = [...uncovered.map((u) => `${u} (not yet shown by any tool result)`), ...contradicted.map((c) => `step ${c.stepId} answered something else: ${c.reason}`)];
  if (gaps.length === 0) return;
  report.missing = Array.from(new Set([...gaps, ...report.missing]));
  report.needsMoreSteps = true;
}

/**
 * The single place outcomes are decided. Fail-closed:
 *   "completed" needs BOTH deterministic independent verification (grounding.ts)
 *   AND the model's agreement. The model alone can never establish completion;
 *   it can only downgrade. Anything not independently verified is at most "unverified".
 */
export function decideOutcome(steps: StepState[], report: VerificationReport | null, cancelled: boolean): RunOutcome {
  const total = steps.length;
  const ok = steps.filter((s) => s.status === "succeeded").length;
  if (cancelled) return "cancelled";
  if (total === 0 || ok === 0) return "failed";
  if (ok < total) return "partial";
  if (!report) return "unverified";
  if (report.grounding.some((g) => g.status === "contradicted")) return "partial";
  if (report.criteriaSatisfied === false) return "partial";
  if (report.independentlyVerified && report.criteriaSatisfied === true) return "completed";
  return "unverified";
}
