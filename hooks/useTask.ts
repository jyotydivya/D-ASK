// ─────────────────────────────────────────────────────────────────────────────
// useTask — React hook for task state + SSE live updates
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
};

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
    case "task.planned":          return `Plan ready — ${payload.nodeCount} steps`;
    case "task.started":          return "Execution started";
    case "task.completed":        return "✓ Task completed";
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
    case "verification.completed": return `Verification ${payload.passed ? "✓ passed" : "✗ failed"}`;
    case "node.completed":        return `✓ ${String(payload.name ?? "")}`;
    case "node.failed":           return `✗ ${String(payload.name ?? "")}`;
    default:                      return "";
  }
}

export type TaskCallbacks = {
  onComplete?: (response: string, taskId: string) => void;
  onFail?: (error: string, taskId: string) => void;
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
        const message = eventToMessage(event);

        setState((prev) => {
          // Deduplicate events by ID
          if (prev.events.some((ex) => ex.id === event.id)) return prev;

          const events = [...prev.events, event].slice(-150);

          let orbState = prev.orbState;
          let isActive = prev.isActive;
          let progressPct = prev.progressPct;
          let pendingApproval = prev.pendingApproval;

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
            orbState,
            isActive,
            progressPct,
            pendingApproval,
            lastMessage: message || prev.lastMessage,
          };
        });

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

  return {
    ...state,
    taskId: activeTaskIdRef.current,
    submitTask,
    cancelTask,
    resolveApproval,
  };
}
