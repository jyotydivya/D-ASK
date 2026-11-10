// ─────────────────────────────────────────────────────────────────────────────
// Deterministic request grounding: independent of any language model.
//
// Each tool may declare a ToolRequestCheck (types.ts). From the request text
// alone it (a) detects the parts of the request it can serve ("facets"), (b)
// judges whether a planned call is justified by the request, and (c) checks
// whether an executed call's output satisfies a facet.
//
// Used in two places:
//   - Planner: a "contradicted" step (e.g. 17+25*2 for a request that says
//     (17+25)*2) rejects the plan before anything runs; the reason feeds repair.
//   - Verifier: "completed" requires independent evidence = all steps
//     succeeded, all grounded, ≥1 facet detected, every facet satisfied.
//
// Conservative by design: anything the detectors do not understand yields NO
// facet / "ungrounded", which caps the outcome at "unverified". Covering the
// detected facets is not enough: every content word of the request must also be
// explained by a detector that fired (unexplainedWords), so a partly-understood
// request ("search the web for today's weather") cannot pass on its understood
// part alone. It never produces "completed" on its own (the model must also agree).
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolRegistry } from "./toolRegistry";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, StepState } from "./types";

/**
 * Request-agnostic function words and politeness/filler. Deliberately contains NO
 * action or topic words: anything that names something to do or look up must be
 * explained by a tool's vocabulary, or the request is not fully accounted for.
 */
const FILLER = new Set(`
a an the this that these those there here it its it's is are was were be been am do does did done have has had
i me my mine you your we us our he she they them what whats what's which who how much many
of in on at to for from by with about into onto as and or also then than so just only please kindly
can could would will shall should may might must let lets let's tell give show me now right currently current
quick quickly exactly simply again some any all each every s t
nothing else
`.trim().split(/\s+/));

/** Content words of the objective, with arithmetic expressions and slash-paths removed. */
export function contentWords(objective: string): string[] {
  const stripped = objective
    .replace(/[\d.]+(?:\s*[-+*/%^×÷x]\s*[\d.(][\d.\s+\-*/%^()×÷x]*)?/g, " ") // numbers and expressions
    .replace(/[()]/g, " ")
    .replace(/(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+[\\/]?/g, " ")       // folder paths
    .toLowerCase()
    .replace(/[’']/g, "'");
  return (stripped.match(/[a-z][a-z']*/g) ?? [])
    .map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
    .filter((w) => w.length > 0 && !FILLER.has(w));
}

/** Words not explained by any tool that detected a facet in this request. */
export function unexplainedWords(registry: ToolRegistry, objective: string, facets: RequestFacet[]): string[] {
  const explained = new Set<string>();
  for (const tool of new Set(facets.map((f) => f.tool))) {
    const vocab = registry.get(tool)?.requestCheck?.vocabulary;
    if (!vocab) continue;
    try { for (const w of vocab(objective)) explained.add(w.toLowerCase()); } catch { /* explains nothing */ }
  }
  return Array.from(new Set(contentWords(objective).filter((w) => !explained.has(w))));
}

export interface GroundingAssessment {
  grounding: { stepId: string; tool: string; status: GroundingVerdict["status"]; reason: string }[];
  facets: { id: string; description: string; satisfied: boolean }[];
  unexplained: string[];
  independentlyVerified: boolean;
  /** Human-readable descriptions of facets not yet covered (fed to follow-up planning). */
  uncovered: string[];
  /**
   * Uncovered steps of an explicitly ordered request (facet.sequence) that were never attempted while every executed step
   * succeeded: the request still names them, nothing failed, so another planning round is justified even when general gap
   * replanning is off. Empty as soon as any step failed (a failed or halted sequence is never continued).
   */
  pendingOrdered: string[];
}

/** All facets any registered tool detects in the request, de-duplicated by id. */
/**
 * Tools whose request check claims the WHOLE request (ToolRequestCheck.claims), e.g. "Save a workflow called X: <steps>":
 * the steps are text to store, not requests to act on. When any tool claims a request, only the claiming tools' facets,
 * clarifications and offer apply; other detectors must not react to the quoted text. Empty: no claim (the usual case).
 */
export function claimingTools(registry: ToolRegistry, objective: string): Set<string> {
  const out = new Set<string>();
  for (const d of registry.list()) {
    const claims = registry.get(d.name)?.requestCheck?.claims;
    try { if (claims?.(objective)) out.add(d.name); } catch { /* a broken detector claims nothing */ }
  }
  return out;
}

export function detectFacets(registry: ToolRegistry, objective: string): RequestFacet[] {
  const out = new Map<string, RequestFacet>();
  const claimed = claimingTools(registry, objective);
  for (const d of registry.list()) {
    const check = registry.get(d.name)?.requestCheck;
    if (!check) continue;
    if (claimed.size && !claimed.has(d.name)) continue;
    let facets: RequestFacet[] = [];
    try { facets = check.facets(objective); } catch { facets = []; }
    for (const f of facets) if (!out.has(f.id)) out.set(f.id, f);
  }
  return [...out.values()];
}

/** The first clarifying question any request check asks for this objective, or null. Deterministic. */
export function clarificationFor(registry: ToolRegistry, objective: string): string | null {
  const claimed = claimingTools(registry, objective);
  for (const d of registry.list()) {
    const check = registry.get(d.name)?.requestCheck;
    if (!check?.clarify) continue;
    if (claimed.size && !claimed.has(d.name)) continue;
    let q: string | null = null;
    try { q = check.clarify(objective); } catch { q = null; }
    if (q) return q;
  }
  return null;
}

/** Whether a tool could concern this request at all (only narrows the no-facet tool offer). */
export function isRelevant(registry: ToolRegistry, tool: string, objective: string): boolean {
  const claimed = claimingTools(registry, objective);
  if (claimed.size) return claimed.has(tool);
  const check = registry.get(tool)?.requestCheck;
  if (!check?.relevant) return true;
  try { return check.relevant(objective); } catch { return true; }
}

export function groundCall(registry: ToolRegistry, tool: string, input: Record<string, unknown>, objective: string): GroundingVerdict {
  const check = registry.get(tool)?.requestCheck;
  if (!check) return { status: "ungrounded", reason: `${tool} declares no request check` };
  try {
    return check.ground(input, objective);
  } catch (err) {
    return { status: "ungrounded", reason: `request check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function assessGrounding(registry: ToolRegistry, objective: string, steps: StepState[]): GroundingAssessment {
  const facets = detectFacets(registry, objective);
  const grounding = steps
    .filter((s) => s.status === "succeeded")
    .map((s) => ({ stepId: s.step.id, tool: s.step.tool, ...groundCall(registry, s.step.tool, s.step.input, objective) }));

  const stepSatisfies = (f: RequestFacet, s: StepState): boolean => {
    const check = registry.get(f.tool)?.requestCheck;
    if (!check || s.status !== "succeeded" || s.step.tool !== f.tool || !s.outcome) return false;
    try { return check.satisfies(f, s.step.input, s.outcome); } catch { return false; }
  };

  // Ordered operations (facet.sequence): each facet needs its OWN executed step, strictly after the step that satisfied the
  // previous one. `steps` is in execution order (the runtime runs plans sequentially, rounds appended). If any link is missing,
  // or fewer facets were detected than the request asked for, none of the later ones can be satisfied.
  const sequenceOk = new Map<string, boolean>();
  const groups = new Map<string, RequestFacet[]>();
  for (const f of facets) if (f.sequence) groups.set(f.sequence.key, [...(groups.get(f.sequence.key) ?? []), f]);
  for (const group of groups.values()) {
    group.sort((a, b) => a.sequence!.index - b.sequence!.index);
    const complete = group.length === group[0]!.sequence!.of && group.every((f, i) => f.sequence!.index === i);
    let after = -1;
    let broken = !complete;
    for (const f of group) {
      if (broken) { sequenceOk.set(f.id, false); continue; }
      const at = steps.findIndex((s, i) => i > after && stepSatisfies(f, s));
      if (at < 0) { broken = true; sequenceOk.set(f.id, false); } else { after = at; sequenceOk.set(f.id, true); }
    }
  }

  const coverage = facets.map((f) => {
    const satisfied = f.sequence ? sequenceOk.get(f.id) === true : steps.some((s) => stepSatisfies(f, s));
    return { id: f.id, description: f.description, satisfied };
  });

  const unexplained = unexplainedWords(registry, objective, facets);
  const independentlyVerified =
    steps.length > 0 &&
    steps.every((s) => s.status === "succeeded") &&
    grounding.every((g) => g.status === "grounded") &&
    coverage.length > 0 &&
    coverage.every((c) => c.satisfied) &&
    unexplained.length === 0;

  const allSucceeded = steps.length > 0 && steps.every((s) => s.status === "succeeded");
  const pendingOrdered = allSucceeded
    ? facets.filter((f) => f.sequence && sequenceOk.get(f.id) !== true).map((f) => f.description)
    : [];
  return { grounding, facets: coverage, unexplained, independentlyVerified, uncovered: coverage.filter((c) => !c.satisfied).map((c) => c.description), pendingOrdered };
}

// ── Request-derived argument domains ────────────────────────────────────────

export type ArgumentDomains = Record<string, Record<string, ArgumentDomain>>;

/** tool name → property → domain, for every registered tool that declares domains. */
export function argumentDomainsFor(registry: ToolRegistry, objective: string): ArgumentDomains {
  const out: ArgumentDomains = {};
  for (const d of registry.list()) {
    const fn = registry.get(d.name)?.requestCheck?.argumentDomains;
    if (!fn) continue;
    try {
      const domains = fn(objective);
      if (Object.keys(domains).length) out[d.name] = domains;
    } catch { /* a broken detector constrains nothing; verification still applies */ }
  }
  return out;
}

/** null if the input respects the request-derived domains; otherwise the reason it does not. */
export function checkArguments(domains: ArgumentDomains, tool: string, input: Record<string, unknown>): string | null {
  const byProp = domains[tool];
  if (!byProp) return null;
  for (const [prop, dom] of Object.entries(byProp)) {
    const v = input[prop];
    if (dom.kind === "forbidden") {
      if (v !== undefined) return `${tool}.${prop} must be omitted for this request (${dom.reason}); got ${JSON.stringify(v)}`;
      continue;
    }
    if (v === undefined) {
      if (!dom.optional) return `${tool}.${prop} is required and must be one of ${dom.values.map((x) => JSON.stringify(x)).join(", ")}`;
      continue;
    }
    const canon = (s: string) => dom.compare === "whitespace" ? s.replace(/\s+/g, "")
      : dom.compare === "path" ? (s.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase() || ".")
      : s;
    if (typeof v !== "string" || !dom.values.some((a) => canon(a) === canon(v))) {
      return `${tool}.${prop} = ${JSON.stringify(v)} is not taken from the request; allowed: ${dom.values.map((x) => JSON.stringify(x)).join(", ")}`;
    }
  }
  return null;
}

// ── Shared text helpers for tool request checks ─────────────────────────────

export const lower = (s: string) => s.toLowerCase();

/** Word-boundary containment, case-insensitive; `needle` is matched literally. */
export function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const esc = needle.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${esc}($|[^a-z0-9_])`, "i").test(haystack);
}
