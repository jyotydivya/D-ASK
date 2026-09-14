// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Agentic Platform — Shared Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

// ── Task ─────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "created"
  | "understanding"
  | "planning"
  | "ready"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_approval"
  | "verifying"
  | "replanning"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "critical";

export interface Task {
  id: string;
  sessionId: string;
  objective: string;
  status: TaskStatus;
  priority: TaskPriority;
  planId?: string;
  finalResponse?: string;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Task Node (DAG vertex) ────────────────────────────────────────────────────

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskNode {
  id: string;
  taskId: string;
  name: string;
  description: string;
  agentType: AgentType;
  status: NodeStatus;
  dependencies: string[]; // node IDs that must complete first
  result?: unknown;
  error?: string;
  attempts: number;
  maxAttempts: number;
  startedAt?: Date;
  completedAt?: Date;
}

// ── Execution Plan ────────────────────────────────────────────────────────────

export interface ExecutionPlan {
  id: string;
  taskId: string;
  objective: string;
  requirements: string[];
  successCriteria: string[];
  nodes: TaskNode[];
  createdAt: Date;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export type AgentType =
  | "research"
  | "coding"
  | "browser"
  | "device"
  | "data"
  | "verifier"
  | "memory"
  | "pc";

export interface AgentResult {
  status: "completed" | "failed" | "needs_approval";
  summary: string;
  findings: Finding[];
  artifacts: Artifact[];
  nextActions: string[];
  toolCallIds: string[];
  error?: string;
  raw?: unknown;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolDefinition {
  name: string;           // e.g. "device.launch_app"
  description: string;
  agentType: AgentType;
  inputSchema: Record<string, unknown>;
  permissions: string[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface ToolCall {
  id: string;
  nodeId: string;
  taskId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
  riskLevel: RiskLevel;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
}

// ── Policy ────────────────────────────────────────────────────────────────────

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

// ── Approval ──────────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  taskId: string;
  nodeId: string;
  toolCallId?: string;
  description: string;
  riskLevel: RiskLevel;
  toolName: string;
  toolArguments: Record<string, unknown>;
  status: ApprovalStatus;
  note?: string;
  decidedAt?: Date;
  createdAt: Date;
}

// ── Blackboard ────────────────────────────────────────────────────────────────

export interface Blackboard {
  taskId: string;
  objective: string;
  requirements: string[];
  successCriteria: string[];
  findings: Finding[];
  decisions: string[];
  artifacts: Artifact[];
  errors: string[];
  agentOutputs: Record<string, unknown>; // nodeId → AgentResult
  deviceContext?: DeviceContext;
}

export interface Finding {
  id: string;
  agent: AgentType;
  nodeId: string;
  claim: string;
  evidence: string[];
  confidence: number;
  createdAt: Date;
}

export interface DeviceContext {
  availableDevices: import("../app/api/devices/route").DeviceInfo[];
  primaryDeviceId?: string;
  lastScanned: Date;
}

// ── Artifact ──────────────────────────────────────────────────────────────────

export type ArtifactType = "file" | "screenshot" | "report" | "diff" | "data" | "url";

export interface Artifact {
  id: string;
  taskId: string;
  nodeId?: string;
  type: ArtifactType;
  name: string;
  content?: string;
  url?: string;
  mimeType?: string;
  createdAt: Date;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type TaskEventType =
  | "task.created"
  | "task.status_changed"
  | "task.planned"
  | "task.started"
  | "task.replanned"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "agent.started"
  | "agent.progress"
  | "agent.completed"
  | "agent.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "approval.required"
  | "approval.completed"
  | "verification.started"
  | "verification.completed"
  | "node.started"
  | "node.completed"
  | "node.failed";

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  timestamp: Date;
  payload: Record<string, unknown>;
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  score: number;           // 0.0 – 1.0
  issues: string[];
  missingRequirements: string[];
  recommendations: string[];
}

// ── Model Router ──────────────────────────────────────────────────────────────

export type ModelTier =
  | "fast"       // classification, extraction → gemini-flash
  | "standard"   // agent reasoning → gemini-pro
  | "reasoning"  // planning, verification → most capable
  | "vision";    // multimodal spatial reasoning → gemini-pro

export interface ModelRequest {
  tier: ModelTier;
  systemPrompt: string;
  userPrompt: string | import("@google/genai").Part[];
  outputSchema?: Record<string, unknown>;
  taskId?: string;
  nodeId?: string;
}

export interface ModelResponse {
  text: string;
  parsed?: unknown;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  model: string;
  durationMs: number;
}

export interface LLMProvider {
  name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  generateStructured<T>(request: ModelRequest): Promise<T>;
}

// ── Orb State ─────────────────────────────────────────────────────────────────

export type OrbState =
  | "standby"
  | "listening"
  | "understanding"
  | "planning"
  | "executing"
  | "tool_use"
  | "waiting"
  | "verifying"
  | "replanning"
  | "completed"
  | "error";

// ── Agent Context (passed to each agent invocation) ───────────────────────────

export interface AgentContext {
  taskId: string;
  nodeId: string;
  objective: string;
  nodeDescription: string;
  relevantFindings: Finding[];
  dependencyOutputs: Record<string, unknown>; // nodeId → result
  availableTools: ToolDefinition[];
  blackboard: Blackboard;
  sessionId: string;
}

// ── Planner Output Schema (structured Gemini output) ─────────────────────────

export interface PlannerNode {
  id: string;
  name: string;
  description: string;
  agentType: AgentType;
  dependencies: string[];
  estimatedDurationMs: number;
  requiresApproval: boolean;
}

export interface PlannerOutput {
  objective: string;
  requirements: string[];
  successCriteria: string[];
  nodes: PlannerNode[];
}

// ── API Request / Response types ──────────────────────────────────────────────

export interface CreateTaskRequest {
  objective: string;
  sessionId?: string;
  priority?: TaskPriority;
  context?: Record<string, unknown>;
}

export interface CreateTaskResponse {
  taskId: string;
  status: TaskStatus;
  message: string;
}

export interface GetTaskResponse {
  task: Task;
  nodes: TaskNode[];
  blackboard: Blackboard;
  recentEvents: TaskEvent[];
  artifacts: Artifact[];
  pendingApproval?: Approval;
}

export interface ApproveTaskRequest {
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
}

export interface ApproveTaskResponse {
  success: boolean;
  taskResumed: boolean;
}
