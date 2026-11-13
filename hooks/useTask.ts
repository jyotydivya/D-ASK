// ─────────────────────────────────────────────────────────────────────────────
// useTask — React hook for task state + SSE live updates
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { NativeAgentClient, isNativeHud, postToHud, rejectionMessage, type NativeTaskResult } from "./nativeAgent";
import type {
  Task,
  TaskNode,
  TaskEvent,
  Artifact,
  Approval,
  OrbState,
  CreateTaskRequest,
} from "../agent/types";

export interface TaskState {
  task: Task | null;
  nodes: TaskNode[];
  events: TaskEvent[];
  artifacts: Artifact[];
  pendingApproval: Approval | null;
  orbState: OrbState;
  isActive: boolean;
  progressPct: number;
  lastMessage: string;
  /** Final outcome as reported by the server (agent runtime: completed | answered | unverified | partial | failed | refused | cancelled). */
  result: TaskResultView | null;
}

export interface TaskResultView {
  outcome: string;
  response: string;
  /** Native HUD only: the daemon's verification report, shown as reported. null means none was reported. */
  independentlyVerified?: boolean | null;
  interrupted?: boolean;
  /** Native HUD only: the result came from the local knowledge index (retrieved passages with checked citations). */
  grounded?: boolean;
}

const INITIAL_STATE: TaskState = {
  task: null,
  nodes: [],
  events: [],
  artifacts: [],
  pendingApproval: null,
  orbState: "standby",
  isActive: false,
  progressPct: 0,
  lastMessage: "",
  result: null,
};

/**
 * Derive the step list from the event stream. Plans arrive as task.planned /
 * task.replanned (payload.steps); step progress as node.started / node.completed /
 * node.failed. Pure, so the panel only ever shows what the server reported.
 */
export function applyNodeEvent(nodes: TaskNode[], event: TaskEvent, taskId: string): TaskNode[] {
  const p = event.payload;
  if ((event.type === "task.planned" || event.type === "task.replanned") && Array.isArray(p.steps)) {
    const known = new Set(nodes.map((n) => n.id));
    const added: TaskNode[] = (p.steps as { id?: unknown; description?: unknown; tool?: unknown; dependsOn?: unknown }[])
      .filter((s) => typeof s.id === "string" && !known.has(s.id))
      .map((s) => ({
        id: String(s.id),
        taskId,
        name: String(s.description ?? s.tool ?? s.id),
        description: String(s.tool ?? ""),
        agentType: "tool",
        status: "pending",
        dependencies: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
        attempts: 0,
        maxAttempts: 1,
      }));
    return added.length ? [...nodes, ...added] : nodes;
  }
  const nodeId = typeof p.nodeId === "string" ? p.nodeId : null;
  if (!nodeId) return nodes;
  const update = (patch: Partial<TaskNode>) => nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  switch (event.type) {
    case "node.started": return update({ status: "running" });
    case "node.completed": return update({ status: "completed", result: p.evidence !== undefined ? { evidence: String(p.evidence) } : undefined });
    case "node.failed": return update({
      status: p.status === "skipped" || p.status === "cancelled" ? "skipped" : "failed",
      error: p.error !== undefined ? String(p.error) : undefined,
    });
    default: return nodes;
  }
}

// Map task status → orb state
function taskStatusToOrbState(status: string): OrbState {
  const map: Record<string, OrbState> = {
    created: "understanding",
    understanding: "understanding",
    planning: "planning",
    ready: "planning",
    running: "executing",
    waiting_for_tool: "tool_use",
    waiting_for_approval: "waiting",
    verifying: "verifying",
    replanning: "replanning",
    completed: "completed",
    failed: "error",
    cancelled: "standby",
  };
  return (map[status] as OrbState) ?? "standby";
}

// Map task event → readable message
export function eventToMessage(event: TaskEvent): string {
  const { type, payload } = event;
  switch (type) {
    case "task.created":          return `Task created`;
    case "task.planned":          return payload.intent === "unsupported"
                                    ? `Cannot plan: ${String(payload.refusalReason ?? "no suitable tool").slice(0, 80)}`
                                    : `Plan ready — ${payload.nodeCount} steps`;
    case "task.started":          return "Execution started";
    case "task.completed":        return outcomeLabel(payload.outcome);
    case "task.failed":           return `✗ ${String(payload.error ?? "Task failed").slice(0, 80)}`;
    case "task.cancelled":        return "Task cancelled";
    case "task.replanned":        return `Replanning...`;
    case "agent.started":         return `[${String(payload.agent ?? "").toUpperCase()}] ${String(payload.nodeName ?? "")}...`;
    case "agent.progress":        return String(payload.message ?? "");
    case "agent.completed":       return `✓ ${String(payload.summary ?? "").slice(0, 80)}`;
    case "agent.failed":          return `✗ ${String(payload.error ?? "").slice(0, 80)}`;
    case "tool.started":          return `⚙ ${String(payload.tool ?? "")}`;
    case "tool.completed":        return `⚙ ${String(payload.tool ?? "")} done`;
    case "tool.failed":           return `✗ ${String(payload.tool ?? "")} — ${String(payload.error ?? "").slice(0, 60)}`;
    case "approval.required":     return `⚠ Approval required for: ${String(payload.tool ?? "")}`;
    case "verification.started":  return "Verifying...";
    case "verification.completed": return `Verification ${payload.passed ? "✓ passed" : "✗ not confirmed"}`;
    case "node.completed":        return `✓ ${String(payload.name ?? "")}`;
    case "node.failed":           return `${payload.status === "skipped" ? "⊘" : "✗"} ${String(payload.name ?? "")}`;
    default:                      return "";
  }
}

/** Honest label for a finished task: the runtime reports partial/unverified results distinctly. */
export function outcomeLabel(outcome: unknown): string {
  switch (outcome) {
    case "answered":   return "✓ Answered";
    case "unverified": return "⚠ Finished — result not confirmed";
    case "partial":    return "⚠ Partially completed";
    case "refused":    return "⊘ Not possible with available tools";
    case "completed":
    case undefined:    return "✓ Task completed";
    default:           return `Task finished: ${String(outcome)}`;
  }
}

/** One task event applied to the panel state. Shared by the browser and native transports. */
export function reduceTaskEvent(prev: TaskState, event: TaskEvent, taskId: string): TaskState {
  // Deduplicate events by ID
  if (prev.events.some((ex) => ex.id === event.id)) return prev;

  const message = eventToMessage(event);
  const events = [...prev.events, event].slice(-150);

  let orbState = prev.orbState;
  let isActive = prev.isActive;
  let progressPct = prev.progressPct;
  let pendingApproval = prev.pendingApproval;
  let result = prev.result;
  const nodes = applyNodeEvent(prev.nodes, event, taskId);

  if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled") {
    const response = event.payload.finalResponse ?? event.payload.error;
    if (response !== undefined || event.payload.outcome !== undefined) {
      result = {
        outcome: String(event.payload.outcome ?? event.type.slice("task.".length)),
        response: String(response ?? ""),
      };
    }
  }

  if (event.type === "task.status_changed") {
    orbState = taskStatusToOrbState(String(event.payload.status ?? ""));
  }
  if (event.type === "task.completed") {
    isActive = false; orbState = "completed";
  }
  if (event.type === "task.failed") {
    isActive = false; orbState = "error";
  }
  if (event.type === "task.cancelled") {
    isActive = false; orbState = "standby";
  }
  if (event.type === "agent.progress" && event.payload.progressPct !== undefined) {
    progressPct = Number(event.payload.progressPct);
  }
  if (event.type === "approval.required") {
    pendingApproval = {
      id: String(event.payload.approvalId ?? ""),
      taskId,
      nodeId: String(event.payload.nodeId ?? ""),
      description: `Approval required for: ${String(event.payload.tool ?? "")}`,
      riskLevel: "high",
      toolName: String(event.payload.tool ?? ""),
      toolArguments: {},
      status: "pending",
      createdAt: new Date(),
    };
  }
  if (event.type === "approval.completed") {
    pendingApproval = null;
  }

  return {
    ...prev,
    events,
    nodes,
    result,
    orbState,
    isActive,
    progressPct,
    pendingApproval,
    lastMessage: message || prev.lastMessage,
  };
}

/** The end of a native task: every field shown comes from the daemon's report. */
export function reduceNativeResult(prev: TaskState, result: NativeTaskResult): TaskState {
  const reported = new Map(result.steps.map((s) => [s.id, s]));
  const nodes = prev.nodes.map((n): TaskNode => {
    const step = reported.get(n.id);
    if (!step) return n.status === "running" || n.status === "pending" ? { ...n, status: "skipped" } : n;
    if (step.status === "succeeded") return { ...n, status: "completed", result: step.detail ? { evidence: step.detail } : n.result };
    return { ...n, status: step.status === "failed" ? "failed" : "skipped", error: step.detail ?? n.error };
  });
  const orbState: OrbState = result.outcome === "completed" || result.outcome === "answered" ? "completed" : result.outcome === "failed" ? "error" : "standby";
  return {
    ...prev,
    nodes,
    orbState,
    isActive: false,
    lastMessage: result.outcome === "cancelled" ? "Task cancelled" : outcomeLabel(result.outcome),
    result: {
      outcome: result.outcome,
      response: result.response,
      independentlyVerified: result.independentlyVerified,
      interrupted: result.interrupted,
      // Knowledge-engine steps are reported with ids "kb-…" (agent/runtime/knowledge/service.ts): the answer came from indexed documents.
      grounded: result.steps.some((s) => s.id.startsWith("kb-")),
    },
  };
}

export type TaskCallbacks = {
  onComplete?: (response: string, taskId: string) => void;
  onFail?: (error: string, taskId: string) => void;
  /** Native HUD: the daemon gave the submitted task this id (recorded on the history entry, so its result can be recovered after a restart). */
  onAccepted?: (taskId: string) => void;
  /** Native HUD: the daemon's answer to recoverTask(taskId); text is null when the result is not known. */
  onRecovered?: (taskId: string, text: string | null, failed: boolean) => void;
};

export function useTask(callbacks?: TaskCallbacks) {
  const [state, setState] = useState<TaskState>(INITIAL_STATE);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  // Track which taskIds we've already fired terminal callbacks for
  const processedTerminalRef = useRef<Set<string>>(new Set());
  // Keep callbacks ref stable so subscribeToEvents closure is always fresh
  const callbacksRef = useRef<TaskCallbacks | undefined>(callbacks);
  callbacksRef.current = callbacks;
  // Set only inside the desktop HUD. A browser always takes the HTTP path below.
  const nativeRef = useRef<NativeAgentClient | null>(null);

  useEffect(() => {
    if (!isNativeHud()) return;
    const client = new NativeAgentClient(
      {
        post: postToHud,
        newId: () => crypto.randomUUID().replace(/-/g, ""),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        now: () => new Date(),
      },
      {
        onAccepted: (taskId) => {
          activeTaskIdRef.current = taskId;
          callbacksRef.current?.onAccepted?.(taskId);
          setState((prev) => ({ ...prev, lastMessage: "Accepted by the local agent" }));
        },
        onEvent: (taskId, event) => setState((prev) => reduceTaskEvent(prev, event, taskId)),
        onCancelling: () => setState((prev) => ({ ...prev, lastMessage: "Cancelling..." })),
        onCancelFailed: (_taskId, message) => setState((prev) => ({ ...prev, lastMessage: message })),
        // A scheduled run the daemon started: shown as its own history entry; the task panel (a task the user is running) is not touched.
        onExternalFinished: (taskId, result) => {
          const label = result.outcome === "completed" || result.outcome === "answered" ? "" : `${outcomeLabel(result.outcome)}
`;
          const text = `SCHEDULED RUN · ${label}${result.response}`;
          if (result.outcome === "failed") callbacksRef.current?.onFail?.(text, taskId);
          else callbacksRef.current?.onComplete?.(text, taskId);
        },
        onRecovered: (taskId, result) => {
          if (!result) { callbacksRef.current?.onRecovered?.(taskId, null, false); return; }
          const label = result.outcome === "completed" || result.outcome === "answered" ? "" : `${outcomeLabel(result.outcome)}
`;
          callbacksRef.current?.onRecovered?.(taskId, `${label}${result.response}`, result.outcome === "failed");
        },
        onFinished: (taskId, result) => {
          setState((prev) => reduceNativeResult(prev, result));
          const id = taskId ?? "";
          if (result.outcome === "failed" || !taskId) {
            callbacksRef.current?.onFail?.(result.response || result.errorCode || "Task failed.", id);
          } else if (result.outcome === "cancelled") {
            callbacksRef.current?.onComplete?.("Task cancelled", id);
          } else {
            const label = result.outcome === "completed" || result.outcome === "answered" ? "" : `${outcomeLabel(result.outcome)}\n`;
            callbacksRef.current?.onComplete?.(`${label}${result.response}`, id);
          }
        },
      },
    );
    nativeRef.current = client;
    const onMessage = (e: MessageEvent) => {
      // Dispatched by the host into this page only; nothing from another window is believed.
      if (e.source !== window) return;
      client.handleMessage(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      nativeRef.current = null;
    };
  }, []);

  // ── Submit a new task objective ─────────────────────────────────────────────

  const subscribeToEvents = useCallback((taskId: string) => {
    const es = new EventSource(`/api/tasks/${taskId}/events`);
    eventSourceRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      const data = e.data as string;
      if (!data || data.startsWith(":")) return; // skip heartbeat comments
      try {
        const event = JSON.parse(data) as TaskEvent;
        event.timestamp = new Date(event.timestamp);

        setState((prev) => reduceTaskEvent(prev, event, taskId));

        // Fire callbacks ONCE per task for terminal events (outside setState)
        if (!processedTerminalRef.current.has(taskId)) {
          if (event.type === "task.completed") {
            processedTerminalRef.current.add(taskId);
            const response = String(event.payload.finalResponse ?? "Task completed.");
            callbacksRef.current?.onComplete?.(response, taskId);
          } else if (event.type === "task.failed") {
            processedTerminalRef.current.add(taskId);
            const error = String(event.payload.error ?? "Task failed.");
            callbacksRef.current?.onFail?.(error, taskId);
          }
        }
      } catch {
        // Ignore malformed SSE frames
      }
    };

    // SSE connections can drop transiently. Wait briefly before declaring failure
    // so we don't spam "Connection lost" on every minor network hiccup.
    let errorTimer: ReturnType<typeof setTimeout> | null = null;

    es.onopen = () => {
      // Clear any pending error timer on successful (re)connect
      if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
    };

    es.onerror = () => {
      if (processedTerminalRef.current.has(taskId)) return; // already terminal
      if (errorTimer) return; // already pending
      errorTimer = setTimeout(() => {
        errorTimer = null;
        if (processedTerminalRef.current.has(taskId)) return;
        // Still no terminal event after delay — surface the error
        processedTerminalRef.current.add(taskId);
        callbacksRef.current?.onFail?.("Connection to task stream lost.", taskId);
        setState((prev) => ({ ...prev, isActive: false, orbState: "error" }));
      }, 3000);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitTask = useCallback(async (objective: string, sessionId?: string): Promise<string | null> => {
    const native = nativeRef.current;
    if (native) {
      if (native.isBusy) {
        callbacksRef.current?.onFail?.(rejectionMessage("busy"), "");
        return null;
      }
      activeTaskIdRef.current = null;
      setState({
        ...INITIAL_STATE,
        orbState: "understanding",
        isActive: true,
        lastMessage: `Received: "${objective.slice(0, 60)}"`,
      });
      native.submit(objective);
      return null;
    }

    // Close any existing stream before starting a new task
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    setState({
      ...INITIAL_STATE,
      orbState: "understanding",
      isActive: true,
      lastMessage: `Received: "${objective.slice(0, 60)}"`,
    });

    try {
      const req: CreateTaskRequest = {
        objective: objective.trim(),
        sessionId,
        priority: "normal",
      };

      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Network error" }));
        const msg = String(err.error ?? "Unknown error");
        setState((prev) => ({ ...prev, orbState: "error", isActive: false, lastMessage: `Error: ${msg}` }));
        return null;
      }

      const data = await response.json() as { taskId: string };
      const taskId = String(data.taskId);
      activeTaskIdRef.current = taskId;
      subscribeToEvents(taskId);
      return taskId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, orbState: "error", isActive: false, lastMessage: `Error: ${msg}` }));
      return null;
    }
  }, [subscribeToEvents]);

  // ── Approve/reject ──────────────────────────────────────────────────────────

  const resolveApproval = useCallback(async (
    taskId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    note?: string
  ): Promise<void> => {
    await fetch(`/api/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, decision, note }),
    });
  }, []);

  // ── Cancel ──────────────────────────────────────────────────────────────────

  const cancelTask = useCallback(async (): Promise<void> => {
    const native = nativeRef.current;
    if (native) {
      // Stays active until the daemon reports how the task actually ended.
      native.cancel();
      setState((prev) => ({ ...prev, lastMessage: "Cancelling..." }));
      return;
    }
    const taskId = activeTaskIdRef.current;
    if (!taskId) return;
    await fetch(`/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setState((prev) => ({ ...prev, isActive: false, orbState: "standby", lastMessage: "Task cancelled" }));
  }, []);

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  /** Native HUD only: ask the daemon for the finished result of a task submitted before the HUD was closed. */
  const recoverTask = useCallback((taskId: string) => { nativeRef.current?.recover(taskId); }, []);

  return {
    ...state,
    taskId: activeTaskIdRef.current,
    recoverTask,
    submitTask,
    cancelTask,
    resolveApproval,
  };
}
