// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Task Service — In-memory task CRUD
// Phase 1: Map-based (replace with PostgreSQL in Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskNode,
  NodeStatus,
  ExecutionPlan,
  Blackboard,
  Artifact,
  ArtifactType,
  Approval,
  ApprovalStatus,
  Finding,
  AgentType,
  PlannerNode,
} from "../agent/types";

// ── In-memory stores ──────────────────────────────────────────────────────────
const tasks = new Map<string, Task>();
const nodesByTask = new Map<string, Map<string, TaskNode>>();
const blackboards = new Map<string, Blackboard>();
const artifactsByTask = new Map<string, Artifact[]>();
const approvals = new Map<string, Approval>(); // approvalId → Approval
const pendingApprovalByTask = new Map<string, string>(); // taskId → approvalId

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────

export const taskService = {
  // ── Tasks ──────────────────────────────────────────────────────────────────

  createTask(
    objective: string,
    sessionId: string,
    priority: TaskPriority = "normal"
  ): Task {
    const id = uid("task");
    const task: Task = {
      id,
      sessionId,
      objective,
      status: "created",
      priority,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    tasks.set(id, task);

    // Initialize blackboard
    const bb: Blackboard = {
      taskId: id,
      objective,
      requirements: [],
      successCriteria: [],
      findings: [],
      decisions: [],
      artifacts: [],
      errors: [],
      agentOutputs: {},
    };
    blackboards.set(id, bb);
    nodesByTask.set(id, new Map());
    artifactsByTask.set(id, []);

    return task;
  },

  getTask(id: string): Task | null {
    return tasks.get(id) ?? null;
  },

  updateTaskStatus(id: string, status: TaskStatus): Task {
    const task = tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated: Task = { ...task, status, updatedAt: new Date() };
    tasks.set(id, updated);
    return updated;
  },

  updateTask(id: string, updates: Partial<Task>): Task {
    const task = tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated: Task = { ...task, ...updates, updatedAt: new Date() };
    tasks.set(id, updated);
    return updated;
  },

  listTasks(sessionId?: string): Task[] {
    const all = Array.from(tasks.values());
    return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
  },

  // ── Task Nodes ─────────────────────────────────────────────────────────────

  setNodesFromPlan(plan: ExecutionPlan): TaskNode[] {
    const nodeMap = nodesByTask.get(plan.taskId) ?? new Map<string, TaskNode>();

    const nodes: TaskNode[] = plan.nodes.map((n) => ({
      id: n.id,
      taskId: plan.taskId,
      name: n.name,
      description: n.description,
      agentType: n.agentType,
      status: "pending" as NodeStatus,
      dependencies: n.dependencies,
      attempts: 0,
      maxAttempts: 3,
    }));

    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }
    nodesByTask.set(plan.taskId, nodeMap);
    return nodes;
  },

  getNodes(taskId: string): TaskNode[] {
    return Array.from(nodesByTask.get(taskId)?.values() ?? []);
  },

  getNode(taskId: string, nodeId: string): TaskNode | null {
    return nodesByTask.get(taskId)?.get(nodeId) ?? null;
  },

  updateNodeStatus(
    taskId: string,
    nodeId: string,
    status: NodeStatus,
    result?: unknown,
    error?: string
  ): TaskNode {
    const nodeMap = nodesByTask.get(taskId);
    if (!nodeMap) throw new Error(`Task ${taskId} has no nodes`);
    const node = nodeMap.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found in task ${taskId}`);

    const updated: TaskNode = {
      ...node,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(status === "running" ? { startedAt: new Date(), attempts: node.attempts + 1 } : {}),
      ...(status === "completed" || status === "failed" ? { completedAt: new Date() } : {}),
    };
    nodeMap.set(nodeId, updated);
    return updated;
  },

  addNodesToTask(taskId: string, newNodes: PlannerNode[]): TaskNode[] {
    const nodeMap = nodesByTask.get(taskId) ?? new Map<string, TaskNode>();
    const added: TaskNode[] = [];

    for (const n of newNodes) {
      if (!nodeMap.has(n.id)) {
        const node: TaskNode = {
          id: n.id,
          taskId,
          name: n.name,
          description: n.description,
          agentType: n.agentType,
          status: "pending",
          dependencies: n.dependencies,
          attempts: 0,
          maxAttempts: 3,
        };
        nodeMap.set(n.id, node);
        added.push(node);
      }
    }
    nodesByTask.set(taskId, nodeMap);
    return added;
  },

  // ── Blackboard ─────────────────────────────────────────────────────────────

  getBlackboard(taskId: string): Blackboard | null {
    return blackboards.get(taskId) ?? null;
  },

  updateBlackboard(taskId: string, updates: Partial<Blackboard>): Blackboard {
    const bb = blackboards.get(taskId);
    if (!bb) throw new Error(`Blackboard for task ${taskId} not found`);
    const updated: Blackboard = { ...bb, ...updates };
    blackboards.set(taskId, updated);
    return updated;
  },

  addFinding(taskId: string, finding: Omit<Finding, "id" | "createdAt">): Finding {
    const bb = blackboards.get(taskId);
    if (!bb) throw new Error(`Blackboard for task ${taskId} not found`);
    const full: Finding = {
      ...finding,
      id: uid("finding"),
      createdAt: new Date(),
    };
    bb.findings.push(full);
    return full;
  },

  setAgentOutput(taskId: string, nodeId: string, output: unknown): void {
    const bb = blackboards.get(taskId);
    if (bb) {
      bb.agentOutputs[nodeId] = output;
    }
  },

  addError(taskId: string, error: string): void {
    const bb = blackboards.get(taskId);
    if (bb) {
      bb.errors.push(error);
    }
  },

  // ── Artifacts ──────────────────────────────────────────────────────────────

  addArtifact(
    taskId: string,
    artifact: Omit<Artifact, "id" | "createdAt">
  ): Artifact {
    const full: Artifact = {
      ...artifact,
      id: uid("art"),
      createdAt: new Date(),
    };
    const list = artifactsByTask.get(taskId) ?? [];
    list.push(full);
    artifactsByTask.set(taskId, list);

    // Also mirror to blackboard
    const bb = blackboards.get(taskId);
    if (bb) bb.artifacts.push(full);

    return full;
  },

  getArtifacts(taskId: string): Artifact[] {
    return artifactsByTask.get(taskId) ?? [];
  },

  // ── Approvals ──────────────────────────────────────────────────────────────

  createApproval(
    taskId: string,
    nodeId: string,
    toolName: string,
    toolArguments: Record<string, unknown>,
    description: string,
    riskLevel: import("../agent/types").RiskLevel,
    toolCallId?: string
  ): Approval {
    const id = uid("appr");
    const approval: Approval = {
      id,
      taskId,
      nodeId,
      toolCallId,
      description,
      riskLevel,
      toolName,
      toolArguments,
      status: "pending",
      createdAt: new Date(),
    };
    approvals.set(id, approval);
    pendingApprovalByTask.set(taskId, id);
    return approval;
  },

  getApproval(approvalId: string): Approval | null {
    return approvals.get(approvalId) ?? null;
  },

  getPendingApproval(taskId: string): Approval | null {
    const id = pendingApprovalByTask.get(taskId);
    if (!id) return null;
    const approval = approvals.get(id);
    return approval?.status === "pending" ? (approval ?? null) : null;
  },

  resolveApproval(
    approvalId: string,
    decision: ApprovalStatus,
    note?: string
  ): Approval {
    const approval = approvals.get(approvalId);
    if (!approval) throw new Error(`Approval ${approvalId} not found`);
    const updated: Approval = {
      ...approval,
      status: decision,
      note,
      decidedAt: new Date(),
    };
    approvals.set(approvalId, updated);
    if (decision !== "pending") {
      pendingApprovalByTask.delete(approval.taskId);
    }
    return updated;
  },

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Get a complete snapshot of task state (for GET /api/tasks/:id).
   */
  getTaskSnapshot(taskId: string) {
    const task = tasks.get(taskId);
    if (!task) return null;
    return {
      task,
      nodes: Array.from(nodesByTask.get(taskId)?.values() ?? []),
      blackboard: blackboards.get(taskId) ?? null,
      artifacts: artifactsByTask.get(taskId) ?? [],
      pendingApproval: this.getPendingApproval(taskId),
    };
  },

  /**
   * Get runnable node IDs (all dependencies completed, node is pending).
   */
  getRunnableNodes(taskId: string): TaskNode[] {
    const nodeMap = nodesByTask.get(taskId);
    if (!nodeMap) return [];

    const nodes = Array.from(nodeMap.values());
    const completedIds = new Set(
      nodes.filter((n) => n.status === "completed").map((n) => n.id)
    );

    return nodes.filter(
      (n) =>
        n.status === "pending" &&
        n.dependencies.every((dep) => completedIds.has(dep))
    );
  },

  /**
   * Check if all nodes for a task are in a terminal state.
   */
  isDAGComplete(taskId: string): boolean {
    const nodes = Array.from(nodesByTask.get(taskId)?.values() ?? []);
    if (nodes.length === 0) return false;
    return nodes.every(
      (n) => n.status === "completed" || n.status === "skipped"
    );
  },

  /**
   * Check if any node has failed with no retries remaining.
   */
  hasUnrecoverableFailure(taskId: string): boolean {
    const nodes = Array.from(nodesByTask.get(taskId)?.values() ?? []);
    return nodes.some(
      (n) => n.status === "failed" && n.attempts >= n.maxAttempts
    );
  },
};
