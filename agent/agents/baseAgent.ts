// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Base Agent — Abstract foundation for all specialized agents
// ─────────────────────────────────────────────────────────────────────────────

import { checkPolicy, sanitizeArgs } from "../../tools/policyEngine";
import { toolRegistry } from "../../tools/registry";
import { taskService } from "../../services/taskService";
import { eventService } from "../../services/eventService";
import { blackboard } from "../blackboard";
import type {
  AgentContext,
  AgentResult,
  AgentType,
  ToolCall,
  ToolDefinition,
} from "../types";

export abstract class BaseAgent {
  abstract readonly agentType: AgentType;
  abstract readonly name: string;
  abstract readonly description: string;

  /**
   * Execute this agent for a specific task node.
   * Subclasses implement this with their domain logic.
   */
  abstract execute(context: AgentContext): Promise<AgentResult>;

  /**
   * Get the tools available to this agent.
   */
  getAvailableTools(): ToolDefinition[] {
    return toolRegistry.getForAgent(this.agentType);
  }

  /**
   * Execute a tool call through the policy engine.
   * This is the ONLY way agents should execute tools — never directly.
   */
  protected async callTool(
    context: AgentContext,
    toolName: string,
    rawArgs: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string; approvalId?: string }> {
    const { taskId, nodeId } = context;

    // 1. Validate tool exists
    const def = toolRegistry.get(toolName);
    if (!def) {
      const error = `Unknown tool: "${toolName}"`;
      blackboard.addError(taskId, error);
      return { success: false, error };
    }

    // 2. Sanitize arguments
    let args: Record<string, unknown>;
    try {
      args = sanitizeArgs(toolName, rawArgs);
    } catch (err) {
      const error = `Argument validation failed for "${toolName}": ${err instanceof Error ? err.message : String(err)}`;
      blackboard.addError(taskId, error);
      return { success: false, error };
    }

    // 3. Policy check
    const policy = await checkPolicy(taskId, nodeId, toolName, args);
    if (!policy.allowed) {
      if (policy.requiresApproval && policy.approvalId) {
        eventService.publish(taskId, "approval.required", {
          approvalId: policy.approvalId,
          tool: toolName,
          nodeId,
        });
        return { success: false, approvalId: policy.approvalId, error: "Awaiting approval" };
      }
      return { success: false, error: policy.reason ?? "Tool call denied by policy" };
    }

    // 4. Record tool call start
    const toolCallId = `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    eventService.publish(taskId, "tool.started", {
      toolCallId,
      tool: toolName,
      nodeId,
      args,
    });

    const startTime = Date.now();

    // 5. Route to tool executor
    try {
      const result = await this.routeTool(toolName, args, context);
      const durationMs = Date.now() - startTime;

      eventService.publish(taskId, "tool.completed", {
        toolCallId,
        tool: toolName,
        nodeId,
        result,
        durationMs,
      });

      return { success: true, result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      eventService.publish(taskId, "tool.failed", {
        toolCallId,
        tool: toolName,
        nodeId,
        error,
        durationMs,
      });

      blackboard.addError(taskId, `Tool "${toolName}" failed: ${error}`);
      return { success: false, error };
    }
  }

  /**
   * Route a tool call to the appropriate executor.
   * Subclasses override this to handle domain-specific tools.
   * Base implementation throws for unknown tools.
   */
  protected async routeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: AgentContext
  ): Promise<unknown> {
    throw new Error(`Agent "${this.name}" does not implement tool "${toolName}"`);
  }

  /**
   * Emit a progress event for the current agent execution.
   */
  protected emitProgress(taskId: string, nodeId: string, message: string, progressPct?: number): void {
    eventService.publish(taskId, "agent.progress", {
      agent: this.agentType,
      nodeId,
      message,
      ...(progressPct !== undefined ? { progressPct } : {}),
    });
  }

  /**
   * Build a structured AgentResult for a successful execution.
   */
  protected success(summary: string, extras: Partial<AgentResult> = {}): AgentResult {
    return {
      status: "completed",
      summary,
      findings: [],
      artifacts: [],
      nextActions: [],
      toolCallIds: [],
      ...extras,
    };
  }

  /**
   * Build a structured AgentResult for a failed execution.
   */
  protected failure(error: string, summary?: string): AgentResult {
    return {
      status: "failed",
      summary: summary ?? `Agent "${this.name}" failed: ${error}`,
      findings: [],
      artifacts: [],
      nextActions: [],
      toolCallIds: [],
      error,
    };
  }
}
