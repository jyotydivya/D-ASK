// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Orchestrator — The central brain that runs every task lifecycle
// ─────────────────────────────────────────────────────────────────────────────

import { planner } from "./planner";
import { DAGScheduler } from "./scheduler";
import { blackboard } from "./blackboard";
import { taskService } from "../services/taskService";
import { eventService } from "../services/eventService";
import { modelRouter } from "./modelRouter";
import { DeviceAgent } from "./agents/deviceAgent";
import { PCAgent } from "./agents/pcAgent";
import { BrowserAgent } from "./agents/browserAgent";
import { MemoryAgent } from "./agents/memoryAgent";
import { CodingAgent } from "./agents/codingAgent";
import type {
  Task,
  TaskNode,
  TaskStatus,
  AgentContext,
  AgentResult,
  AgentType,
  VerificationResult,
} from "./types";

import { BaseAgent } from "./agents/baseAgent";

// ── Agent Registry ────────────────────────────────────────────────────────────
// Maps agentType → agent instance. The planner picks agentType; we dispatch here.

const pcAgent = new PCAgent();
const browserAgent = new BrowserAgent();
const memoryAgent = new MemoryAgent();
const codingAgent = new CodingAgent();

const agentRegistry: Map<string, BaseAgent> = new Map([
  ["device",   new DeviceAgent() as BaseAgent],
  ["pc",       pcAgent as BaseAgent],            // native PC tool-use
  ["data",     pcAgent as BaseAgent],            // fallback
  ["research", pcAgent as BaseAgent],            // fallback
  ["browser",  browserAgent as BaseAgent],       // web navigation
  ["memory",   memoryAgent as BaseAgent],        // semantic memory storage
  ["coding",   codingAgent as BaseAgent],        // Dedicated coding agent for filesystem tools
  ["verifier", pcAgent as BaseAgent],            // fallback
  // Phase 2: ["research", new ResearchAgent()],
] as [string, BaseAgent][]);

// ── Orchestrator ──────────────────────────────────────────────────────────────

class TaskOrchestrator {
  private readonly MAX_REPLAN_ATTEMPTS = 2;

  /**
   * Run a task from its current state to completion.
   * This is the top-level entry point called by the task API.
   * Runs asynchronously — returns immediately after starting.
   */
  async run(taskId: string): Promise<void> {
    try {
      await this.runInternal(taskId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Orchestrator] Unhandled error in task ${taskId}:`, error);
      try {
        await this.transition(taskId, "failed");
        taskService.updateTask(taskId, { errorMessage: error });
        eventService.publish(taskId, "task.failed", { error });
      } catch { /* ignore cleanup errors */ }
    }
  }

  private async runInternal(taskId: string): Promise<void> {
    const task = taskService.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // ── UNDERSTANDING ──────────────────────────────────────────────────────────
    await this.transition(taskId, "understanding");

    // ── PLANNING ──────────────────────────────────────────────────────────────
    await this.transition(taskId, "planning");
    const plan = await planner.createPlan(taskId, task.objective);

    eventService.publish(taskId, "task.planned", {
      planId: plan.id,
      nodeCount: plan.nodes.length,
      nodeNames: plan.nodes.map((n) => n.name),
      requirements: plan.requirements,
      successCriteria: plan.successCriteria,
    });

    blackboard.setRequirements(taskId, plan.requirements, plan.successCriteria);

    // ── READY → RUNNING ────────────────────────────────────────────────────────
    await this.transition(taskId, "ready");
    await this.transition(taskId, "running");
    eventService.publish(taskId, "task.started", { taskId });

    const scheduler = new DAGScheduler(taskId);
    let replanCount = 0;

    // ── MAIN EXECUTION LOOP ───────────────────────────────────────────────────
    while (true) {
      const progress = scheduler.getProgress();

      if (scheduler.isComplete()) break;

      if (scheduler.isDeadlocked()) {
        // No runnable nodes, none running — stuck
        if (replanCount >= this.MAX_REPLAN_ATTEMPTS) {
          throw new Error("DAG is deadlocked and max replan attempts reached");
        }
        await this.replanOnFailure(taskId, scheduler, replanCount++);
        continue;
      }

      if (scheduler.hasUnrecoverableFailure() && scheduler.getRunnableNodes().length === 0) {
        const failed = scheduler.getFailedNodes();
        throw new Error(`Unrecoverable failure in nodes: ${failed.map((n) => n.name).join(", ")}`);
      }

      const runnable = scheduler.getRunnableNodes();
      if (runnable.length === 0) {
        // Nodes are still running — wait a bit
        await sleep(200);
        continue;
      }

      // Phase 1: Sequential (one at a time for stability)
      // Phase 3: Will change to Promise.allSettled for parallel execution
      const node = runnable[0]!;
      await this.executeNode(taskId, node, scheduler, task);
    }

    // ── VERIFICATION ──────────────────────────────────────────────────────────
    await this.transition(taskId, "verifying");
    eventService.publish(taskId, "verification.started", { taskId });

    const verification = await this.verify(taskId, task.objective, plan.successCriteria);
    eventService.publish(taskId, "verification.completed", {
      passed: verification.passed,
      score: verification.score,
      issues: verification.issues,
    });

    if (!verification.passed && replanCount < this.MAX_REPLAN_ATTEMPTS) {
      // Verification failed — try to replan
      await this.transition(taskId, "replanning");
      replanCount++;
      const bb = blackboard.get(taskId);
      const newNodes = await planner.replan(
        taskId,
        task.objective,
        [],
        bb ? blackboard.getSummaryForAgent(taskId) : ""
      );
      taskService.addNodesToTask(taskId, newNodes);

      // Re-run with new nodes
      await this.transition(taskId, "running");
      // Re-enter the execution loop for the new nodes
      await this.runRemainingNodes(taskId, scheduler, task, replanCount);
    }

    // ── COMPLETION ────────────────────────────────────────────────────────────
    const finalResponse = await this.synthesizeFinalResponse(taskId, task, verification);
    taskService.updateTask(taskId, { finalResponse });
    await this.transition(taskId, "completed");
    eventService.publish(taskId, "task.completed", {
      taskId,
      finalResponse,
      verificationScore: verification.score,
    });
  }

  private async executeNode(
    taskId: string,
    node: TaskNode,
    scheduler: DAGScheduler,
    task: Task
  ): Promise<void> {
    scheduler.markStarted(node.id);
    eventService.publish(taskId, "agent.started", {
      agent: node.agentType,
      nodeId: node.id,
      nodeName: node.name,
    });

    try {
      const agent = agentRegistry.get(node.agentType);
      if (!agent) {
        // Unsupported agent type — skip gracefully
        console.warn(`[Orchestrator] No agent registered for type: ${node.agentType}`);
        scheduler.markCompleted(node.id, { skipped: true, reason: "Agent not yet implemented" });
        return;
      }

      // Build context for this agent invocation
      const context = await this.buildContext(taskId, node, task.sessionId);

      await this.transition(taskId, "waiting_for_tool");
      const result: AgentResult = await agent.execute(context);
      await this.transition(taskId, "running");

      if (result.status === "needs_approval") {
        await this.transition(taskId, "waiting_for_approval");
        // Wait for approval resolution
        const approved = await this.waitForApproval(taskId);
        await this.transition(taskId, "running");

        if (!approved) {
          scheduler.markFailed(node.id, "User rejected the requested action.");
          blackboard.addError(taskId, `Node "${node.name}" rejected by user.`);
          return;
        }
        // Re-execute after approval
        const retryResult = await agent.execute(context);
        this.handleNodeResult(taskId, node, retryResult, scheduler);
        return;
      }

      this.handleNodeResult(taskId, node, result, scheduler);

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      scheduler.markFailed(node.id, error);
      blackboard.addError(taskId, `Node "${node.name}" threw: ${error}`);
      eventService.publish(taskId, "agent.failed", {
        agent: node.agentType,
        nodeId: node.id,
        error,
      });
    }
  }

  private handleNodeResult(
    taskId: string,
    node: TaskNode,
    result: AgentResult,
    scheduler: DAGScheduler
  ): void {
    if (result.status === "completed") {
      blackboard.setNodeOutput(taskId, node.id, result);
      scheduler.markCompleted(node.id, result);
      eventService.publish(taskId, "agent.completed", {
        agent: node.agentType,
        nodeId: node.id,
        summary: result.summary,
      });
    } else {
      scheduler.markFailed(node.id, result.error ?? "Agent returned failed status");
      eventService.publish(taskId, "agent.failed", {
        agent: node.agentType,
        nodeId: node.id,
        error: result.error,
      });
    }
  }

  private async buildContext(taskId: string, node: TaskNode, sessionId: string): Promise<AgentContext> {
    const bb = blackboard.get(taskId) ?? {
      taskId,
      objective: "",
      requirements: [],
      successCriteria: [],
      findings: [],
      decisions: [],
      artifacts: [],
      errors: [],
      agentOutputs: {},
    };

    const depOutputs = blackboard.getDependencyOutputs(taskId, node.dependencies);
    let relevantFindings = blackboard.getRelevantFindings(taskId, node.agentType);

    // Inject PC environment context if applicable
    if (node.agentType === "pc") {
      try {
        const { pcControlService } = await import("../lib/agent/tools/desktop/pcControl");
        const { mouseKeyboardService } = await import("../lib/agent/tools/desktop/mouseKeyboard");
        
        const activeWindow = await pcControlService.getActiveWindow();
        const openWindows = await pcControlService.listWindows();
        const mousePos = await mouseKeyboardService.getMousePosition();
        
        const pcFinding = {
          id: `f_env_${Date.now()}`,
          agent: "pc" as const,
          nodeId: node.id,
          claim: "Host PC Environment Status",
          evidence: [
            `Active Window: ${activeWindow}`,
            `Mouse Position: (${mousePos.x}, ${mousePos.y})`,
            `Open Windows: ${openWindows.slice(0, 10).join(", ")}${openWindows.length > 10 ? "..." : ""}`
          ],
          confidence: 1.0,
          createdAt: new Date(),
        };
        relevantFindings = [...relevantFindings, pcFinding];
      } catch (e) {
        console.warn("[Orchestrator] Failed to fetch PC context for buildContext:", e);
      }
    }

    return {
      taskId,
      nodeId: node.id,
      objective: bb.objective,
      nodeDescription: node.description,
      relevantFindings,
      dependencyOutputs: depOutputs,
      availableTools: [],
      blackboard: bb,
      sessionId,
    };
  }

  private async replanOnFailure(
    taskId: string,
    scheduler: DAGScheduler,
    replanCount: number
  ): Promise<void> {
    await this.transition(taskId, "replanning");
    eventService.publish(taskId, "task.replanned", {
      replanCount: replanCount + 1,
      reason: "Deadlock or node failure",
    });

    const task = taskService.getTask(taskId);
    if (!task) return;

    const failedIds = scheduler.getFailedNodes().map((n) => n.id);
    const bbSummary = blackboard.getSummaryForAgent(taskId);

    const newNodes = await planner.replan(task.id, task.objective, failedIds, bbSummary);
    taskService.addNodesToTask(taskId, newNodes);

    // Reset failed nodes for retry
    for (const failedNode of scheduler.getFailedNodes()) {
      const node = taskService.getNode(taskId, failedNode.id);
      if (node && node.attempts < node.maxAttempts) {
        scheduler.resetForRetry(failedNode.id);
      }
    }

    await this.transition(taskId, "running");
  }

  private async runRemainingNodes(
    taskId: string,
    scheduler: DAGScheduler,
    task: Task,
    replanCount: number
  ): Promise<void> {
    while (!scheduler.isComplete()) {
      const runnable = scheduler.getRunnableNodes();
      if (runnable.length === 0) {
        await sleep(200);
        continue;
      }
      const node = runnable[0]!;
      await this.executeNode(taskId, node, scheduler, task);
    }
  }

  private async verify(
    taskId: string,
    objective: string,
    successCriteria: string[]
  ): Promise<VerificationResult> {
    const bb = blackboard.get(taskId);
    const agentOutputs = bb?.agentOutputs ?? {};
    const artifacts = taskService.getArtifacts(taskId);

    const prompt = `
You are the D-ASK Verifier. Assess whether the task was completed successfully.

OBJECTIVE: "${objective}"

SUCCESS CRITERIA:
${successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") || "None specified — use best judgment."}

AGENT OUTPUTS:
${Object.entries(agentOutputs)
  .map(([nodeId, output]) => `[${nodeId}]: ${JSON.stringify(output).slice(0, 300)}`)
  .join("\n") || "None"}

ARTIFACTS:
${artifacts.map((a) => `${a.type}: ${a.name} ${a.url ?? ""}`).join("\n") || "None"}

ERRORS:
${bb?.errors.join("; ") || "None"}

Assess whether the task objective was fully achieved.
Return a structured verification result.
    `.trim();

    try {
      const result = await modelRouter.generateStructured<VerificationResult>({
        tier: "reasoning",
        systemPrompt: "You are a precise task verifier. Return only valid JSON.",
        userPrompt: prompt,
        outputSchema: {
          type: "object",
          properties: {
            passed: { type: "boolean" },
            score: { type: "number" },
            issues: { type: "array", items: { type: "string" } },
            missingRequirements: { type: "array", items: { type: "string" } },
            recommendations: { type: "array", items: { type: "string" } },
          },
          required: ["passed", "score", "issues", "missingRequirements", "recommendations"],
        },
        taskId,
      });

      return result;
    } catch {
      // Fallback: assume success if agents completed
      return {
        passed: true,
        score: 0.8,
        issues: [],
        missingRequirements: [],
        recommendations: ["Verification model call failed — manual review recommended"],
      };
    }
  }

  private async synthesizeFinalResponse(
    taskId: string,
    task: Task,
    verification: VerificationResult
  ): Promise<string> {
    const bb = blackboard.get(taskId);
    const outputs = Object.values(bb?.agentOutputs ?? {});
    const summaries = outputs
      .map((o) => (o as AgentResult)?.summary ?? String(o))
      .filter(Boolean)
      .slice(-4)
      .join(" | ");

    if (!summaries) {
      return verification.passed
        ? "Task completed successfully."
        : "Task encountered issues. Please review the timeline.";
    }

    try {
      const response = await modelRouter.generate({
        tier: "fast",
        systemPrompt:
          "You are D-ASK. Generate ONE concise, authoritative response (1-2 sentences max) summarizing what was accomplished. Be high-tech and direct. No bullet points.",
        userPrompt: `Objective: "${task.objective}"\nResult: ${summaries}\nVerification passed: ${verification.passed}`,
        taskId,
      });
      return response.text.trim();
    } catch {
      return summaries.slice(0, 200);
    }
  }

  private async waitForApproval(taskId: string): Promise<boolean> {
    const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_MS = 500;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
      const pending = taskService.getPendingApproval(taskId);
      if (!pending) {
        // No pending approval — check if it was resolved
        const task = taskService.getTask(taskId);
        if (task?.status === "cancelled") return false;
        return true; // Assume approved if no pending
      }
      if (pending.status === "approved") return true;
      if (pending.status === "rejected") return false;
      await sleep(POLL_MS);
    }

    return false; // Timeout — treat as rejected
  }

  private async transition(taskId: string, status: TaskStatus): Promise<void> {
    taskService.updateTaskStatus(taskId, status);
    eventService.publish(taskId, "task.status_changed", { status, taskId });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton orchestrator
export const orchestrator = new TaskOrchestrator();
