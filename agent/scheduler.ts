// ─────────────────────────────────────────────────────────────────────────────
// D-ASK DAG Scheduler — Finds and dispatches runnable task nodes
// ─────────────────────────────────────────────────────────────────────────────

import { taskService } from "../services/taskService";
import { eventService } from "../services/eventService";
import type { TaskNode } from "./types";

export class DAGScheduler {
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  /**
   * Get all nodes that are ready to run:
   * - status is "pending"
   * - all dependencies have status "completed"
   */
  getRunnableNodes(): TaskNode[] {
    return taskService.getRunnableNodes(this.taskId);
  }

  /**
   * Get all nodes currently running.
   */
  getRunningNodes(): TaskNode[] {
    return taskService.getNodes(this.taskId).filter((n) => n.status === "running");
  }

  /**
   * Get all failed nodes.
   */
  getFailedNodes(): TaskNode[] {
    return taskService.getNodes(this.taskId).filter((n) => n.status === "failed");
  }

  /**
   * Check if the DAG is fully complete (all nodes completed or skipped).
   */
  isComplete(): boolean {
    return taskService.isDAGComplete(this.taskId);
  }

  /**
   * Check if there is an unrecoverable failure (failed node with max retries reached).
   */
  hasUnrecoverableFailure(): boolean {
    return taskService.hasUnrecoverableFailure(this.taskId);
  }

  /**
   * Check if there are no runnable nodes and not all nodes are complete.
   * This indicates a deadlock (e.g., circular deps or blocking failure).
   */
  isDeadlocked(): boolean {
    const nodes = taskService.getNodes(this.taskId);
    const pending = nodes.filter((n) => n.status === "pending");
    const running = nodes.filter((n) => n.status === "running");
    const runnable = this.getRunnableNodes();

    return pending.length > 0 && running.length === 0 && runnable.length === 0;
  }

  /**
   * Mark a node as started.
   */
  markStarted(nodeId: string): TaskNode {
    const node = taskService.updateNodeStatus(this.taskId, nodeId, "running");
    eventService.publish(this.taskId, "node.started", {
      nodeId,
      name: node.name,
      agent: node.agentType,
    });
    return node;
  }

  /**
   * Mark a node as completed.
   */
  markCompleted(nodeId: string, result: unknown): TaskNode {
    const node = taskService.updateNodeStatus(this.taskId, nodeId, "completed", result);
    eventService.publish(this.taskId, "node.completed", {
      nodeId,
      name: node.name,
      agent: node.agentType,
    });
    return node;
  }

  /**
   * Mark a node as failed.
   */
  markFailed(nodeId: string, error: string): TaskNode {
    const node = taskService.getNode(this.taskId, nodeId);
    const attempts = (node?.attempts ?? 0);
    const maxAttempts = (node?.maxAttempts ?? 3);

    const updated = taskService.updateNodeStatus(this.taskId, nodeId, "failed", undefined, error);
    eventService.publish(this.taskId, "node.failed", {
      nodeId,
      name: updated.name,
      agent: updated.agentType,
      error,
      attempts,
      maxAttempts,
      canRetry: attempts < maxAttempts,
    });
    return updated;
  }

  /**
   * Reset a failed node back to pending (for retry).
   */
  resetForRetry(nodeId: string): TaskNode {
    return taskService.updateNodeStatus(this.taskId, nodeId, "pending");
  }

  /**
   * Get a progress summary: { total, completed, running, failed, pending }.
   */
  getProgress(): {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    pct: number;
  } {
    const nodes = taskService.getNodes(this.taskId);
    const total = nodes.length;
    const completed = nodes.filter((n) => n.status === "completed" || n.status === "skipped").length;
    const running = nodes.filter((n) => n.status === "running").length;
    const failed = nodes.filter((n) => n.status === "failed").length;
    const pending = nodes.filter((n) => n.status === "pending").length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, running, failed, pending, pct };
  }
}
