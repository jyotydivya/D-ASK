// ─────────────────────────────────────────────────────────────────────────────
// Runtime wiring: default tool registry, permission grants, and the bridge to
// D-ASK's existing task/event services (so /api/tasks, the SSE stream and the
// AgentStatusPanel work unchanged).
// ─────────────────────────────────────────────────────────────────────────────

import { taskService } from "../../services/taskService";
import { eventService } from "../../services/eventService";
import type { PlannerNode, TaskStatus } from "../types";
import { SelectedLanguageModel } from "./inference";
import { AgentRuntime } from "./runtime";
import { errMessage } from "./toolRegistry";
import { DEFAULT_GRANTS, createDefaultRegistry } from "./defaults";
import type { ConversationTurn, RunReport, RuntimeEvent, StepStatus } from "./types";

export { AgentRuntime } from "./runtime";
export { ToolRegistry } from "./toolRegistry";
export type * from "./types";

export { DEFAULT_GRANTS, createDefaultRegistry };

// ── Process-wide state (survives Next.js dev module reloads) ─────────────────

interface BridgeState {
  runtime: AgentRuntime | null;
  controllers: Map<string, AbortController>;
  history: Map<string, ConversationTurn[]>;
}
const STATE_KEY = Symbol.for("dask.agentRuntime.bridge.v1");
function state(): BridgeState {
  const g = globalThis as unknown as Record<symbol, BridgeState | undefined>;
  return (g[STATE_KEY] ??= { runtime: null, controllers: new Map(), history: new Map() });
}

function defaultRuntime(): AgentRuntime {
  const s = state();
  return (s.runtime ??= new AgentRuntime({
    // Local llama-server unless DASK_INFERENCE=cloud is set explicitly. No fallback.
    model: new SelectedLanguageModel(),
    registry: createDefaultRegistry(),
    granted: DEFAULT_GRANTS,
  }));
}

const MAX_HISTORY_TURNS = 5;

// ── Bridge ───────────────────────────────────────────────────────────────────

/**
 * Run an already-created task (taskService) through the agent runtime, publishing
 * progress on the task's event stream. Never throws; the task always ends in a
 * terminal state.
 */
export async function runRuntimeTask(taskId: string, deps: { runtime?: AgentRuntime } = {}): Promise<RunReport | null> {
  const task = taskService.getTask(taskId);
  if (!task) return null;

  const s = state();
  const controller = new AbortController();
  s.controllers.set(taskId, controller);
  const history = s.history.get(task.sessionId) ?? [];

  const setStatus = (status: TaskStatus) => {
    const current = taskService.getTask(taskId);
    if (!current || current.status === "cancelled") return; // never resurrect a cancelled task
    taskService.updateTaskStatus(taskId, status);
    eventService.publish(taskId, "task.status_changed", { status, taskId });
  };

  const sink = { emit: (e: RuntimeEvent) => publish(taskId, e, setStatus) };

  try {
    const report = await (deps.runtime ?? defaultRuntime()).run({
      taskId,
      objective: task.objective,
      history,
      signal: controller.signal,
      sink,
    });
    s.history.set(task.sessionId, [...history, { objective: task.objective, outcome: report.outcome, response: report.response }].slice(-MAX_HISTORY_TURNS));
    finish(taskId, report);
    return report;
  } catch (err) {
    // AgentRuntime.run does not throw by design; this is a last-resort guard.
    const error = `Agent runtime failure: ${errMessage(err)}`;
    if (taskService.getTask(taskId)?.status !== "cancelled") {
      taskService.updateTask(taskId, { status: "failed", errorMessage: error });
      eventService.publish(taskId, "task.failed", { error, outcome: "failed", engine: "runtime" });
    }
    return null;
  } finally {
    s.controllers.delete(taskId);
  }
}

/** Abort a running runtime task. Returns false if no run is active for it. */
export function cancelRuntimeTask(taskId: string): boolean {
  const controller = state().controllers.get(taskId);
  if (!controller) return false;
  controller.abort(new Error("cancelled by user"));
  return true;
}

export function isRuntimeTaskActive(taskId: string): boolean {
  return state().controllers.has(taskId);
}

/** Test hook: forget process-wide bridge state. */
export function resetRuntimeBridgeForTests(): void {
  const s = state();
  s.runtime = null;
  s.controllers.clear();
  s.history.clear();
}

// ── Event mapping: RuntimeEvent → existing task model + event stream ─────────

const NODE_STATUS: Record<StepStatus, "pending" | "running" | "completed" | "failed" | "skipped"> = {
  pending: "pending",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "skipped",
};

function publish(taskId: string, e: RuntimeEvent, setStatus: (s: TaskStatus) => void): void {
  switch (e.type) {
    case "phase": {
      const map = { understanding: "understanding", planning: "planning", executing: "running", verifying: "verifying", replanning: "replanning" } as const;
      setStatus(map[e.phase]);
      if (e.phase === "verifying") eventService.publish(taskId, "verification.started", { taskId });
      return;
    }
    case "plan": {
      const nodes: PlannerNode[] = e.plan.steps.map((s) => ({
        id: s.id,
        name: s.description,
        description: `${s.tool} ${JSON.stringify(s.input)}`,
        agentType: "tool",
        dependencies: s.dependsOn,
        estimatedDurationMs: 0,
        requiresApproval: false,
      }));
      taskService.addNodesToTask(taskId, nodes);
      const bb = taskService.getBlackboard(taskId);
      if (bb) {
        taskService.updateBlackboard(taskId, {
          requirements: [...bb.requirements, e.plan.goal],
          successCriteria: [...bb.successCriteria, ...e.plan.successCriteria],
        });
      }
      const payload = {
        engine: "runtime",
        iteration: e.iteration,
        intent: e.plan.intent,
        goal: e.plan.goal,
        refusalReason: e.plan.refusalReason,
        successCriteria: e.plan.successCriteria,
        nodeCount: e.plan.steps.length,
        nodeNames: e.plan.steps.map((s) => s.description),
        steps: e.plan.steps.map((s) => ({ id: s.id, description: s.description, tool: s.tool, dependsOn: s.dependsOn })),
      };
      eventService.publish(taskId, e.iteration > 1 ? "task.replanned" : "task.planned", { ...payload, replanCount: e.iteration - 1 });
      if (e.iteration === 1 && e.plan.intent !== "unsupported") eventService.publish(taskId, "task.started", { taskId });
      return;
    }
    case "step.started": {
      taskService.updateNodeStatus(taskId, e.stepId, "running");
      eventService.publish(taskId, "node.started", { nodeId: e.stepId, name: e.description, tool: e.tool });
      eventService.publish(taskId, "tool.started", { nodeId: e.stepId, tool: e.tool, args: e.input });
      return;
    }
    case "step.finished": {
      const status = NODE_STATUS[e.status];
      const node = taskService.getNode(taskId, e.stepId);
      taskService.updateNodeStatus(taskId, e.stepId, status, e.evidence ? { evidence: e.evidence } : undefined, e.error);
      if (e.status === "succeeded") {
        taskService.addFinding(taskId, { agent: "tool", nodeId: e.stepId, claim: e.tool, evidence: [e.evidence ?? ""], confidence: 1 });
        eventService.publish(taskId, "tool.completed", { nodeId: e.stepId, tool: e.tool, durationMs: e.durationMs, evidence: e.evidence });
        eventService.publish(taskId, "node.completed", { nodeId: e.stepId, name: node?.name ?? e.stepId, evidence: e.evidence });
      } else {
        if (e.status === "failed") {
          eventService.publish(taskId, "tool.failed", { nodeId: e.stepId, tool: e.tool, error: e.error, durationMs: e.durationMs });
        }
        taskService.addError(taskId, `${e.stepId} (${e.tool}): ${e.status}: ${e.error ?? ""}`);
        eventService.publish(taskId, "node.failed", { nodeId: e.stepId, name: node?.name ?? e.stepId, status: e.status, error: e.error });
      }
      return;
    }
    case "approval.denied":
      eventService.publish(taskId, "agent.progress", { agent: "tool", nodeId: e.stepId, message: `Refused ${e.tool}: ${e.reason}` });
      return;
    case "verification": {
      const r = e.report;
      eventService.publish(taskId, "verification.completed", {
        passed: r.stepsSucceeded === r.stepsTotal && r.criteriaSatisfied === true && r.independentlyVerified,
        independentlyVerified: r.independentlyVerified,
        facets: r.facets,
        grounding: r.grounding,
        score: r.stepsTotal ? r.stepsSucceeded / r.stepsTotal : 0,
        stepsSucceeded: r.stepsSucceeded,
        stepsTotal: r.stepsTotal,
        criteriaSatisfied: r.criteriaSatisfied,
        method: r.method,
        needsMoreSteps: r.needsMoreSteps,
        issues: [...r.missing, ...r.notes],
      });
      return;
    }
    case "finished":
      return; // handled by finish() once run() returns
  }
}

function finish(taskId: string, report: RunReport): void {
  const current = taskService.getTask(taskId);
  if (!current) return;
  const summary = {
    engine: "runtime",
    outcome: report.outcome,
    finalResponse: report.response,
    stepsSucceeded: report.steps.filter((s) => s.status === "succeeded").length,
    stepsTotal: report.steps.length,
    iterations: report.iterations,
    toolCalls: report.toolCalls,
    verificationScore: report.verification && report.verification.stepsTotal
      ? report.verification.stepsSucceeded / report.verification.stepsTotal : 0,
  };

  if (current.status === "cancelled" || report.outcome === "cancelled") {
    taskService.updateTask(taskId, { status: "cancelled", finalResponse: report.response });
    if (current.status !== "cancelled") eventService.publish(taskId, "task.cancelled", { taskId, ...summary });
    return;
  }
  if (report.outcome === "failed") {
    taskService.updateTask(taskId, { status: "failed", finalResponse: report.response, errorMessage: report.error ?? report.response });
    eventService.publish(taskId, "task.failed", { ...summary, error: report.response });
    return;
  }
  // completed | unverified | partial | refused: the run finished; `outcome` says how well.
  taskService.updateTask(taskId, { status: "completed", finalResponse: report.response });
  eventService.publish(taskId, "task.completed", { taskId, ...summary });
}
