// ─────────────────────────────────────────────────────────────────────────────
// D-ASK 2.0 Agent Runtime — core types
//
// Layers (each depends only on the ones above it):
//   schema      → structural validation of tool inputs and model output
//   tools       → ToolRegistry: discovery, validation, permissions, execution
//   brain       → reasoning: the ONLY layer that talks to a language model
//   planner     → turns a brain proposal into a validated Plan (or refuses)
//   verifier    → decides success from evidence; the model cannot override evidence
//   runtime     → orchestration: state, limits, timeouts, cancellation, events
// ─────────────────────────────────────────────────────────────────────────────

// ── JSON-schema subset used for tool inputs ──────────────────────────────────

export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: string }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema; maxItems?: number }
  | {
      type: "object";
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
      /** Defaults to false: unknown properties are rejected. */
      additionalProperties?: boolean;
    };

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Coarse capability a tool needs. The runtime is configured with the set it
 * grants; a tool needing anything else is refused before execution.
 */
export type ToolPermission =
  | "read:clock"
  | "read:system"
  | "read:workspace"
  | "read:desktop"
  /** Phase 7B.2: ask the daemon to request the user's approval of a window operation. Performs nothing. */
  | "request:desktop_action"
  | "compute"
  | "write:workspace"
  | "network"
  | "desktop:actuate"
  | "process:spawn"
  /** Local persistent memory (agent/runtime/memory): read saved memories / store or delete what the user asked. */
  | "memory:read"
  | "memory:write";

export type ToolRisk = "low" | "medium" | "high" | "critical";

export interface ToolExecutionContext {
  /** Aborted on cancellation or when the step's timeout elapses. Tools must honour it. */
  readonly signal: AbortSignal;
  readonly taskId: string;
  readonly stepId: string;
  /** The user's request this step serves (absent in direct invocations). Tools that budget approvals per requested
   *  action (element-bound input) read it; it is never sent anywhere. */
  readonly objective?: string;
}

/** What a tool returns. `evidence` is a short human-readable statement of what was observed. */
export interface ToolOutcome<O = unknown> {
  ok: boolean;
  output?: O;
  error?: string;
  evidence: string;
}

export interface ToolSpec<I = Record<string, unknown>, O = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  permissions: readonly ToolPermission[];
  risk: ToolRisk;
  /** If true the tool is never run without an explicit approval from the ApprovalGate. */
  requiresApproval: boolean;
  timeoutMs: number;
  execute(input: I, ctx: ToolExecutionContext): Promise<ToolOutcome<O>>;
  /**
   * Optional postcondition, checked by the verifier on the tool's own output.
   * Returning ok:false turns a "successful" call into a failed step.
   */
  check?(input: I, outcome: ToolOutcome<O>): { ok: boolean; reason?: string };
  /**
   * Optional deterministic request-to-execution validation (see grounding.ts).
   * Without it, a step using this tool can never count as independent evidence,
   * so a task using it can reach at most "unverified".
   */
  requestCheck?: ToolRequestCheck<I, O>;
  /** Called once when a task ends (any outcome, including cancellation): release per-task resources (e.g. a browser). */
  endTask?(taskId: string): Promise<void> | void;
}

// ── Deterministic request grounding ──────────────────────────────────────────

/** A part of the user's request that a tool can serve, detected deterministically from the request text. */
export interface RequestFacet {
  id: string;
  tool: string;
  description: string;
  data?: unknown;
  /**
   * Set when the request asks for several operations in order (Phase 7B.3). Facets sharing a `key` are satisfied only by
   * DIFFERENT executed steps, in `index` order, and only when all `of` of them were detected; otherwise none is satisfied.
   */
  sequence?: { key: string; index: number; of: number };
}

export type GroundingStatus =
  | "grounded"      // the call is justified by the request text
  | "ungrounded"    // nothing in the request text supports (or refutes) the call
  | "contradicted"; // the request text says something different (e.g. a different expression)

export interface GroundingVerdict {
  status: GroundingStatus;
  reason: string;
}

/**
 * Values an input property may take for THIS request, derived deterministically
 * from the request text (never by a model).
 *   enum       only these values; `optional` says whether the property may be omitted
 *   forbidden  the property must be omitted (e.g. no time zone named → local time)
 */
export type ArgumentDomain =
  | {
      kind: "enum";
      values: readonly string[];
      optional: boolean;
      /** How a value is compared with the allowed ones: verbatim, ignoring whitespace, or as a folder path. */
      compare?: "exact" | "whitespace" | "path";
    }
  | { kind: "forbidden"; reason: string };

export interface ToolRequestCheck<I = Record<string, unknown>, O = unknown> {
  /**
   * Request-derived argument domains, by input property. A property absent from
   * the result is unconstrained. Enforced in the output grammar, in the planner
   * prompt, and by a hard check before execution.
   */
  argumentDomains?(objective: string): Record<string, ArgumentDomain>;
  /** Facets of the request this tool can serve. Must be deterministic and conservative. */
  facets(objective: string): RequestFacet[];
  /** Whether a planned call is justified by the request (checked before AND after execution). */
  ground(input: I, objective: string): GroundingVerdict;
  /** Whether an executed call's output satisfies a facet this tool detected. */
  satisfies(facet: RequestFacet, input: I, outcome: ToolOutcome<O>): boolean;
  /**
   * Words of the request this tool accounts for, when (and only when) it detected
   * at least one facet. Used to establish that the WHOLE request is explained:
   * any content word no detector explains caps the task at "unverified".
   */
  vocabulary?(objective: string): readonly string[];
  /**
   * Whether this request could concern the tool at all. Used only to decide what the model is offered when no
   * facet was detected; it never affects validation or verification. Absent means "could".
   */
  relevant?(objective: string): boolean;
  /**
   * A question to ask instead of acting, when the request refers to something it does not identify
   * (e.g. "this report" with no file named). Checked before planning; the first non-null answer wins.
   */
  clarify?(objective: string): string | null;
  /**
   * How many exactly identical steps of this tool (same canonical input) the request itself asks for. Used only by the
   * planner's duplicate removal for approval-gated tools; absent means 1 (later identical copies are removed).
   */
  identicalStepsAllowed?(input: Record<string, unknown>, objective: string): number;
  /**
   * The exact input for an ordered-sequence facet (facet.sequence) when the request alone determines EVERY argument
   * (window, control, text or keys), else null. Lets the runtime continue an explicit "X, then Y" request whose later
   * steps the model left out, without asking the model to re-plan values it may not change anyway. The step still
   * passes the argument-domain check, the tool's own order gate and (for input) a separate user approval.
   */
  stepFor?(facet: RequestFacet, objective: string): Record<string, unknown> | null;
  /**
   * True when this tool owns the WHOLE request and the rest of its text is content, not instructions (e.g. the steps of a
   * workflow being saved). Then only claiming tools' facets, clarifications and offer apply (grounding.claimingTools).
   */
  claims?(objective: string): boolean;
  /**
   * Puts a proposed plan into the order the REQUEST dictates, when the request fully determines it (an application session:
   * "open X, then type Y"). Pure and deterministic: it uses only the request text, never the model's values for the steps it
   * adds, and every step (added or not) then goes through the same validation, argument domains, grounding and approvals.
   */
  arrangeSteps?(steps: ProposedStep[], objective: string): ProposedStep[];
}

export interface ProposedStep { id: string; description?: string; tool: string; input: Record<string, unknown>; dependsOn?: string[] }

/** Public description of a tool, safe to show to a model or a UI. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  permissions: readonly ToolPermission[];
  risk: ToolRisk;
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  taskId: string;
  stepId: string;
  tool: string;
  input: Record<string, unknown>;
  risk: ToolRisk;
}

/** Decides whether an approval-required tool call may run. Must fail closed. */
export interface ApprovalGate {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason: string }>;
}

// ── Brain (language model boundary) ──────────────────────────────────────────

/**
 * A standard JSON Schema object sent to the model to constrain its output.
 * Wider than JsonSchema above (it uses anyOf/const), and only ever a hint to the
 * model: output is still validated independently by the planner and verifier.
 */
export type ModelOutputSchema = Readonly<Record<string, unknown>>;

export interface StructuredRequest {
  purpose: "plan" | "assess" | "answer";
  system: string;
  user: string;
  signal: AbortSignal;
  /** Optional output constraint. Conforming output is NOT trusted on that basis. */
  schema?: ModelOutputSchema;
  /** Optional cap on generated tokens. Implementations apply their own default when unset. */
  maxTokens?: number;
}

/**
 * Provider-independent model interface. Implementations adapt a concrete SDK
 * (inference/llamaServerModel.ts for local inference; inference/cloudModel.ts
 * only when DASK_INFERENCE=cloud). Must return parsed JSON or throw.
 */
export interface LanguageModel {
  readonly name: string;
  generateJson(req: StructuredRequest): Promise<unknown>;
}

export type IntentKind = "task" | "question" | "unsupported";

export interface ConversationTurn {
  objective: string;
  outcome: RunOutcome;
  response: string;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
}

export interface Plan {
  intent: IntentKind;
  goal: string;
  /** Why the request can't be served, when intent is "unsupported". */
  refusalReason?: string;
  /** Set by the runtime (never the model) when the request must be clarified before anything runs. */
  clarification?: string;
  successCriteria: string[];
  steps: PlanStep[];
  /**
   * Set by plan validation (never the model): exact duplicate window-action steps that were removed, each with the
   * retained step it duplicated. Ids and tool names only; never inputs.
   */
  removedDuplicateSteps?: { id: string; duplicateOf: string; tool: string }[];
}

// ── Execution state ──────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface StepState {
  step: PlanStep;
  status: StepStatus;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  outcome?: ToolOutcome;
  error?: string;
}

export type RunOutcome =
  | "completed"    // every step succeeded, deterministic grounding + facet coverage passed, AND the model agreed
  | "unverified"   // every step succeeded, but completion could not be established independently
  | "partial"      // some steps succeeded, some did not
  | "failed"       // nothing useful was achieved, or planning failed
  | "refused"      // the request is outside what the available tools can do
  | "cancelled"
  // An informational question that needs no tool and no computer action, answered by the local model itself (conversation.ts).
  // Never "completed" and never independently verified: nothing was checked against a source, and the HUD says so.
  | "answered";

export interface VerificationReport {
  stepsSucceeded: number;
  stepsTotal: number;
  /** Model's (advisory) judgement. null when the semantic check could not be performed. */
  criteriaSatisfied: boolean | null;
  needsMoreSteps: boolean;
  missing: string[];
  method: "evidence+model" | "evidence-only";
  notes: string[];
  /** Deterministic grounding verdict per executed step. */
  grounding: { stepId: string; tool: string; status: GroundingStatus; reason: string }[];
  /** Request facets detected deterministically, and whether executed evidence covers each. */
  facets: { id: string; description: string; satisfied: boolean }[];
  /** Content words of the request no detector accounts for (non-empty → not independently verified). */
  unexplained: string[];
  /**
   * True only if: every step succeeded, every step is grounded in the request,
   * at least one facet was detected, every detected facet is satisfied by
   * executed evidence, AND every content word of the request is explained by a
   * detected facet. Required for "completed"; the model alone cannot set it.
   */
  independentlyVerified: boolean;
}

export interface RunReport {
  taskId: string;
  outcome: RunOutcome;
  plan: Plan | null;
  steps: StepState[];
  verification: VerificationReport | null;
  response: string;
  iterations: number;
  toolCalls: number;
  error?: string;
  /** Ids of the user's saved memories offered to the planner as context (transparency); absent when none were. */
  memoryContext?: { ids: string[] };
  /** The typed result of this run that a LATER step may use (compose.ts). Set by the knowledge engine, or derived from a tool's typed output (artifact.ts). */
  artifact?: Artifact;
}

// ── Typed intermediate results ───────────────────────────────────────────────

/** Where one piece of an artifact came from: a document (path, page), a web page (URL), a window, a memory. */
export interface ArtifactSource { label: string; ref: string; page?: number | null }

/**
 * A typed, provenance-preserving result. Produced deterministically from what a tool returned (never from model text alone), it can be
 * passed to a later step only through an ordinary request whose text contains it, so grammars, grounding, approvals and Emergency Stop
 * apply exactly as if the user had typed it.
 */
export interface Artifact {
  kind: "answer" | "passages" | "report" | "page" | "file-summary" | "file-text" | "window-text" | "memory" | "list" | "plugin-output" | "text";
  /** The content to pass on (already redacted by the producing tool where it redacts). */
  text: string;
  sources: ArtifactSource[];
  provenance: {
    /** The tool or engine that produced it (e.g. "knowledge.answer", "browser.read_page"). */
    tool: string;
    objective: string;
    outcome: RunOutcome;
    /** Whether the producing run was independently verified (null: no verification applies, e.g. a model-written answer). */
    verified: boolean | null;
    /** True when the content came from the internet (a page the user named). */
    online: boolean;
    at: string;
    /** Knowledge answers only: the code's citation check of the answer (knowledge/ground.ts validate), and the question it answers. */
    grounding?: "grounded" | "partially-grounded" | "insufficient" | "extractive";
    question?: string;
  };
  /** A file the result lives in (a saved research report, the file that was read). */
  file?: string;
}

/** Source of advisory planning context from the user's saved local memories (agent/runtime/memory/planningContext.ts). */
export interface PlanningMemorySource {
  contextFor(objective: string): { lines: string[]; ids: string[] };
}

// ── Events (runtime → UI / logs) ─────────────────────────────────────────────

export type RuntimeEvent =
  | { type: "phase"; phase: "understanding" | "planning" | "executing" | "verifying" | "replanning" }
  | { type: "plan"; plan: Plan; iteration: number }
  | { type: "step.started"; stepId: string; tool: string; description: string; input: Record<string, unknown> }
  | { type: "step.finished"; stepId: string; tool: string; status: StepStatus; evidence?: string; error?: string; durationMs: number }
  | { type: "approval.denied"; stepId: string; tool: string; reason: string }
  | { type: "verification"; report: VerificationReport }
  | { type: "finished"; report: RunReport };

export interface EventSink {
  emit(event: RuntimeEvent): void;
}

// ── Limits ───────────────────────────────────────────────────────────────────

export interface RuntimeLimits {
  /** Maximum steps accepted in one plan. */
  maxStepsPerPlan: number;
  /** Maximum plan → execute → verify rounds (1 = no follow-up planning). */
  maxIterations: number;
  /** Hard cap on tool executions across the whole run. */
  maxToolCalls: number;
  /** Wall-clock budget for the whole run. */
  runTimeoutMs: number;
  /** Upper bound on any single model call. */
  modelTimeoutMs: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = Object.freeze({
  maxStepsPerPlan: 8,
  maxIterations: 2,
  maxToolCalls: 12,
  runTimeoutMs: 120_000,
  modelTimeoutMs: 30_000,
});
