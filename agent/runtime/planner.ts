// ─────────────────────────────────────────────────────────────────────────────
// Planner — turns a Brain proposal into a validated Plan, or refuses.
//
// A model proposal is untrusted. A plan is accepted only if:
//   - it has the expected shape,
//   - every step names a registered tool the runtime is permitted to use,
//   - every step input passes that tool's schema,
//   - step ids are unique; any model-written dependsOn points only to EARLIER
//     steps (self/forward/cycles are rejected); the runtime then generates the
//     actual dependencies itself (strictly sequential),
//   - no input references another step's result (not supported; rejected),
//   - inputs respect request-derived argument domains (grounding.ts),
//   - it stays within the step limit,
//   - [experimental, off by default] no step is "contradicted" by the request.
// One repair round is allowed (errors are fed back to the model); then it fails.
// ─────────────────────────────────────────────────────────────────────────────

import type { Brain } from "./brain";
import { validate } from "./schema";
import type { ToolRegistry } from "./toolRegistry";
import { errMessage } from "./toolRegistry";
import { argumentDomainsFor, checkArguments, detectFacets, groundCall, isRelevant, type ArgumentDomains } from "./grounding";
import type {
  ConversationTurn,
  IntentKind,
  JsonSchema,
  Plan,
  PlanStep,
  ToolPermission,
} from "./types";

const PROPOSAL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["intent", "goal", "steps"],
  properties: {
    intent: { type: "string", enum: ["task", "question", "unsupported"] },
    goal: { type: "string", maxLength: 300 },
    refusalReason: { type: "string", maxLength: 500 },
    successCriteria: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
    steps: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "tool", "input"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
          description: { type: "string", maxLength: 300 },
          tool: { type: "string", maxLength: 64 },
          input: { type: "object", properties: {}, additionalProperties: true },
          dependsOn: { type: "array", maxItems: 20, items: { type: "string", maxLength: 32 } },
        },
      },
    },
  },
};

export interface PlanRequest {
  objective: string;
  history: ConversationTurn[];
  observations?: string[];
  maxSteps: number;
  granted: ReadonlySet<ToolPermission>;
  /** Prefix applied to step ids (keeps ids unique across follow-up rounds). */
  idPrefix?: string;
  /**
   * Steps that already SUCCEEDED in earlier rounds of this task. A follow-up plan's exact copies of them (approval-gated
   * DEDUPLICATED_TOOLS only) count against the request's allowance, so a re-plan never asks for a performed, verified
   * input again (it would be refused and block the steps after it).
   */
  performed?: { id: string; tool: string; input: Record<string, unknown> }[];
  /** The user's own saved memories relevant to this request (advisory context; never argument values). */
  memory?: string[];
  signal: AbortSignal;
}

export type PlanResult = { ok: true; plan: Plan; attempts: number } | { ok: false; error: string; attempts: number };

export interface PlannerOptions {
  /**
   * EXPERIMENTAL (default false): reject whole plans whose steps a deterministic
   * request check calls "contradicted", and spend the repair round on them.
   * Phase 4 (0.5B) measured valid-after-repair falling from 92% to 58% with it on.
   */
  groundingCheck?: boolean;
  /**
   * Product (default true): request-derived argument domains (grounding.ts) are
   * put in the prompt and output schema, and plans violating them are rejected.
   * false exists ONLY for research ablations.
   */
  argumentConstraints?: boolean;
  /**
   * Product (default true): offer the model only the tools whose deterministic request check recognised part of
   * the request (all tools when none did). A tool with no detected facet can never be part of a "completed" result,
   * so this removes only options that could at best end "unverified". Measured in Phase 7A: with eight tools, 0.5B
   * fell from 22 to 12 of 36 on the Phase 4 suite when offered everything. false exists for research ablations.
   */
  requestToolOffer?: boolean;
}

/** Inputs that try to use another step's result. Not supported: rejected, never silently dropped. */
const STEP_REFERENCE = /\{\{[^}]*\}\}|\$\{[^}]*\}|\$(?:s|step)\d+\b|\b(?:s|step)\s*\d+\s*\.\s*(?:output|result|value|evidence)\b|\b(?:output|result) of (?:step|s)\s*\d+\b|\b(?:result|results|output|outputs|response|previous|prev|evidence)\s*(?:\[|\.\s*(?:value|values|output|result|text|time|data|stdout|evidence)\b|\.\s*[A-Za-z_]\w*\s*[.([])/i;

function findStepReference(value: unknown): string | null {
  if (typeof value === "string") return STEP_REFERENCE.test(value) ? value : null;
  if (Array.isArray(value)) { for (const v of value) { const r = findStepReference(v); if (r) return r; } return null; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) { const r = findStepReference(v); if (r) return r; } }
  return null;
}

export class Planner {
  private readonly groundingCheck: boolean;
  private readonly argumentConstraints: boolean;
  private readonly requestToolOffer: boolean;

  constructor(private readonly brain: Brain, private readonly registry: ToolRegistry, opts: PlannerOptions = {}) {
    this.groundingCheck = opts.groundingCheck ?? false;
    this.argumentConstraints = opts.argumentConstraints ?? true;
    this.requestToolOffer = opts.requestToolOffer ?? true;
  }

  /** The tools offered to the model for this objective (see PlannerOptions.requestToolOffer). */
  toolsFor(objective: string, granted: ReadonlySet<ToolPermission>) {
    const all = this.registry.listUsable(granted);
    if (!this.requestToolOffer) return all;
    // A tool whose required argument this request forbids (e.g. a read when no file is named) can never
    // produce a valid call, so it is not offered.
    const domains = this.domainsFor(objective);
    const usable = all.filter((t) => {
      const required = ((t.inputSchema as { required?: readonly string[] }).required) ?? [];
      return !required.some((p) => domains[t.name]?.[p]?.kind === "forbidden");
    });
    if (usable.length === 0) return all;
    const wanted = new Set(detectFacets(this.registry, objective).map((f) => f.tool));
    const offered = usable.filter((t) => wanted.has(t.name));
    if (offered.length) return offered;
    // No facet detected: offer every usable tool that could concern the request at all.
    const relevant = usable.filter((t) => isRelevant(this.registry, t.name, objective));
    return relevant.length ? relevant : usable;
  }

  /** Request-derived argument domains for this objective (empty when constraints are off). */
  domainsFor(objective: string): ArgumentDomains {
    return this.argumentConstraints ? argumentDomainsFor(this.registry, objective) : {};
  }

  async createPlan(req: PlanRequest): Promise<PlanResult> {
    const tools = this.toolsFor(req.objective, req.granted);
    const argumentDomains = this.domainsFor(req.objective);
    let repairErrors: string[] | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let proposal: unknown;
      try {
        proposal = await this.brain.proposePlan(
          { objective: req.objective, tools, history: req.history, observations: req.observations, repairErrors, maxSteps: req.maxSteps, argumentDomains,
            ...(req.memory?.length ? { memory: req.memory } : {}) },
          req.signal,
        );
      } catch (err) {
        return { ok: false, error: errMessage(err), attempts: attempt };
      }

      const checked = this.check(proposal, { ...req, objective: req.objective });
      if (checked.ok) return { ok: true, plan: checked.plan, attempts: attempt };
      repairErrors = checked.errors;
      if (req.signal.aborted) break;
    }
    return { ok: false, error: `The model did not produce a valid plan: ${(repairErrors ?? []).slice(0, 5).join("; ")}`, attempts: 2 };
  }

  /** Pure validation of a proposal. Exposed for tests. */
  check(proposal: unknown, req: Pick<PlanRequest, "maxSteps" | "granted" | "idPrefix" | "performed"> & { objective?: string }): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
    const shape = validate(PROPOSAL_SCHEMA, proposal, "plan");
    if (!shape.ok) return { ok: false, errors: shape.errors.slice(0, 10) };

    const p = proposal as {
      intent: IntentKind; goal: string; refusalReason?: string; successCriteria?: string[];
      steps: { id: string; description?: string; tool: string; input: Record<string, unknown>; dependsOn?: string[] }[];
    };

    if (p.intent === "unsupported") {
      return {
        ok: true,
        plan: {
          intent: "unsupported",
          goal: p.goal,
          refusalReason: p.refusalReason?.trim() || "No available tool can perform this request.",
          successCriteria: [],
          steps: [],
        },
      };
    }

    // A request that fully determines its own step order (an application session) arranges the proposal first; every step,
    // proposed or added, is then validated exactly like any other below.
    if (req.objective !== undefined) {
      for (const d of this.registry.list()) {
        const arrange = this.registry.get(d.name)?.requestCheck?.arrangeSteps;
        if (!arrange) continue;
        try { p.steps = arrange(p.steps, req.objective) as typeof p.steps; } catch { /* a broken arranger changes nothing */ }
      }
    }
    const errors: string[] = [];
    if (p.steps.length === 0) errors.push("a task or question needs at least one step");
    if (p.steps.length > req.maxSteps) errors.push(`too many steps (${p.steps.length} > ${req.maxSteps})`);

    const usable = new Set(this.registry.listUsable(req.granted).map((t) => t.name));
    const domains = req.objective !== undefined ? this.domainsFor(req.objective) : {};
    const seen = new Set<string>();
    const prefix = req.idPrefix ?? "";
    const steps: PlanStep[] = [];

    for (const s of p.steps) {
      if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
      if (!this.registry.has(s.tool)) errors.push(`step ${s.id}: unknown tool "${s.tool}"`);
      else if (!usable.has(s.tool)) errors.push(`step ${s.id}: tool "${s.tool}" is not permitted in this runtime`);
      else {
        const inputErrors = this.registry.validateInput(s.tool, s.input);
        const ref = findStepReference(s.input);
        if (inputErrors.length) errors.push(`step ${s.id}: ${inputErrors.join("; ")}`);
        else if (ref !== null) errors.push(`step ${s.id}: input ${JSON.stringify(ref).slice(0, 80)} references another step's result; passing data between steps is not supported`);
        else {
          const argError = checkArguments(domains, s.tool, s.input);
          if (argError) errors.push(`step ${s.id}: ${argError}`);
          else if (this.groundingCheck && req.objective !== undefined) {
            const verdict = groundCall(this.registry, s.tool, s.input, req.objective);
            if (verdict.status === "contradicted") errors.push(`step ${s.id}: ${verdict.reason}`);
          }
        }
      }
      // The model is not an authority on dependencies. A reference to an earlier step is
      // already implied by sequential execution; anything else (self, later, unknown,
      // i.e. any cycle) is rejected explicitly rather than silently dropped.
      for (const d of s.dependsOn ?? []) {
        if (d === s.id) errors.push(`step ${s.id}: depends on itself; steps run in order and need no dependsOn`);
        else if (!seen.has(d)) errors.push(`step ${s.id}: dependsOn "${d}" is not an earlier step; steps run in the listed order and cannot use later steps`);
      }
      seen.add(s.id);
      const previous = steps.at(-1);
      steps.push({
        id: prefix + s.id,
        description: s.description?.trim() || `Run ${s.tool}`,
        tool: s.tool,
        input: s.input,
        // Deterministic, runtime-generated: strictly sequential. A failed step stops the
        // steps after it (fail-closed), even though current tools pass no data.
        dependsOn: previous ? [previous.id] : [],
      });
    }

    if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
    const objective = req.objective;
    const allowance = objective === undefined ? undefined : (tool: string, input: Record<string, unknown>) => {
      const fn = this.registry.get(tool)?.requestCheck?.identicalStepsAllowed;
      try { return fn ? fn(input, objective) : 1; } catch { return 1; }
    };
    const { kept, removed } = removeExactDuplicateWindowActions(steps, allowance, req.performed);
    return {
      ok: true,
      plan: {
        intent: p.intent, goal: p.goal, successCriteria: p.successCriteria ?? [], steps: kept,
        ...(removed.length ? { removedDuplicateSteps: removed } : {}),
      },
    };
  }
}

/**
 * Window-action tools whose exact duplicates are removed from a validated plan. Each needs the user's approval and the
 * daemon allows one approval per task, so a repeated identical step can never run: it would only fail and turn a fully
 * performed, verified action into "partially done". Only these tools; every other tool's steps are left as planned.
 */
// P1/P2: element-bound input too. Observed with the local 0.5B model (2026-11-09): the SAME type_text step five times in one
// plan; without this each copy would ask the user for another approval of the same text.
export const DEDUPLICATED_TOOLS: ReadonlySet<string> = new Set(["desktop.focus_window", "desktop.set_window_state",
  "desktop.click_element", "desktop.type_text", "desktop.press_keys",
  // Browser stage 2: each is separately approved too (a repeat would only be refused by the tool's order gate).
  "browser.click_element", "browser.fill_field",
  // Found in the real-HUD feature run (2026-11-10): the local model planned filesystem.undo_organize 8 times; the daemon refuses
  // every copy after the first (one approval per task), which turned a verified undo into "partial". Same rationale as above.
  "filesystem.organize", "filesystem.undo_organize", "workflow.save", "workflow.delete", "workflow.unschedule", "workflow.schedule",
  "plugin.install", "plugin.remove", "plugin.grant", "plugin.revoke_permission", "plugin.enable", "plugin.disable", "notes.create",
  // Found in the real-HUD management-panel run (2026-11-12): the local model planned plugin.list three times and the reply repeated the list. Read-only list tools: an exact
  // duplicate adds nothing (and unlike system.time no test relies on repeating them).
  "plugin.list", "memory.list", "workflow.list",
  // Found in the real-HUD cross-feature run (2026-11-13): the same 8-fold repeat of filesystem.undo_copy_rename turned a verified undo into "partial".
  // Copy, rename and their undo are approved once per task, like organise.
  "filesystem.copy", "filesystem.rename", "filesystem.undo_copy_rename"]);

/** Canonical JSON (object keys sorted, recursively), so inputs compare by content, not by key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Keeps the first occurrence of each (tool, exactly identical canonical input) among DEDUPLICATED_TOOLS and drops later
 * exact duplicates. Order of retained steps is preserved and dependencies are re-linked to the previous retained step
 * (execution is strictly sequential). Anything not exactly identical (another tool, target, state or argument) is kept.
 */
export function removeExactDuplicateWindowActions(
  steps: PlanStep[],
  /** How many identical copies the request itself asks for (multi-step input: "press Backspace, then press Backspace"). Default 1. */
  allowance?: (tool: string, input: Record<string, unknown>) => number,
  /** Steps already performed in earlier rounds: they count as earlier copies (a re-plan never repeats them beyond the allowance). */
  performed?: readonly { id: string; tool: string; input: Record<string, unknown> }[],
): { kept: PlanStep[]; removed: { id: string; duplicateOf: string; tool: string }[] } {
  const firstByKey = new Map<string, string>();
  const countByKey = new Map<string, number>();
  for (const p of performed ?? []) {
    if (!DEDUPLICATED_TOOLS.has(p.tool)) continue;
    const key = `${p.tool}|${canonicalJson(p.input)}`;
    if (!firstByKey.has(key)) firstByKey.set(key, p.id);
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }
  const kept: PlanStep[] = [];
  const removed: { id: string; duplicateOf: string; tool: string }[] = [];
  for (const s of steps) {
    if (DEDUPLICATED_TOOLS.has(s.tool)) {
      const key = `${s.tool}|${canonicalJson(s.input)}`;
      const first = firstByKey.get(key);
      const seen = countByKey.get(key) ?? 0;
      const allowed = Math.max(1, allowance ? allowance(s.tool, s.input) : 1);
      if (first !== undefined && seen >= allowed) { removed.push({ id: s.id, duplicateOf: first, tool: s.tool }); continue; }
      if (first === undefined) firstByKey.set(key, s.id);
      countByKey.set(key, seen + 1);
    }
    const previous = kept.at(-1);
    kept.push({ ...s, dependsOn: previous ? [previous.id] : [] });
  }
  return { kept, removed };
}
