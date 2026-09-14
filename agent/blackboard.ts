// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Blackboard — Shared state for cross-agent communication
// ─────────────────────────────────────────────────────────────────────────────

import { taskService } from "../services/taskService";
import type { Blackboard, Finding, AgentType, Artifact, DeviceContext } from "./types";
import type { DeviceInfo } from "../app/api/devices/route";

export const blackboard = {
  /**
   * Get the shared blackboard for a task.
   */
  get(taskId: string): Blackboard | null {
    return taskService.getBlackboard(taskId);
  },

  /**
   * Set the requirements and success criteria from the planner.
   */
  setRequirements(
    taskId: string,
    requirements: string[],
    successCriteria: string[]
  ): void {
    taskService.updateBlackboard(taskId, { requirements, successCriteria });
  },

  /**
   * Add a structured finding from an agent.
   */
  addFinding(
    taskId: string,
    finding: Omit<Finding, "id" | "createdAt">
  ): Finding {
    return taskService.addFinding(taskId, finding);
  },

  /**
   * Store the output of a specific node.
   */
  setNodeOutput(taskId: string, nodeId: string, output: unknown): void {
    taskService.setAgentOutput(taskId, nodeId, output);
  },

  /**
   * Get the output of a specific node (for dependency resolution).
   */
  getNodeOutput(taskId: string, nodeId: string): unknown {
    const bb = taskService.getBlackboard(taskId);
    return bb?.agentOutputs[nodeId];
  },

  /**
   * Get outputs for all completed dependency nodes.
   */
  getDependencyOutputs(
    taskId: string,
    dependencyNodeIds: string[]
  ): Record<string, unknown> {
    const bb = taskService.getBlackboard(taskId);
    if (!bb) return {};
    const result: Record<string, unknown> = {};
    for (const nodeId of dependencyNodeIds) {
      if (bb.agentOutputs[nodeId] !== undefined) {
        result[nodeId] = bb.agentOutputs[nodeId];
      }
    }
    return result;
  },

  /**
   * Get findings relevant to a specific agent or topic.
   * Simple keyword filter for Phase 1 — replace with embedding search in Phase 8.
   */
  getRelevantFindings(
    taskId: string,
    agentType?: AgentType,
    keywords?: string[]
  ): Finding[] {
    const bb = taskService.getBlackboard(taskId);
    if (!bb) return [];

    let findings = bb.findings;

    if (agentType) {
      findings = findings.filter((f) => f.agent === agentType);
    }

    if (keywords && keywords.length > 0) {
      const kws = keywords.map((k) => k.toLowerCase());
      findings = findings.filter((f) =>
        kws.some((kw) => f.claim.toLowerCase().includes(kw))
      );
    }

    // Sort by confidence descending, take top 10
    return findings.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  },

  /**
   * Update the device context (which devices are available).
   */
  setDeviceContext(taskId: string, devices: DeviceInfo[], primaryId?: string): void {
    const deviceContext: DeviceContext = {
      availableDevices: devices,
      primaryDeviceId: primaryId,
      lastScanned: new Date(),
    };
    taskService.updateBlackboard(taskId, { deviceContext });
  },

  /**
   * Get the primary device ID from context.
   */
  getPrimaryDeviceId(taskId: string): string | null {
    const bb = taskService.getBlackboard(taskId);
    return bb?.deviceContext?.primaryDeviceId ?? null;
  },

  /**
   * Record an error on the blackboard.
   */
  addError(taskId: string, error: string): void {
    taskService.addError(taskId, error);
  },

  /**
   * Record an artifact (screenshot, report, diff, etc.).
   */
  addArtifact(taskId: string, artifact: Omit<Artifact, "id" | "createdAt">): Artifact {
    return taskService.addArtifact(taskId, artifact);
  },

  /**
   * Get a summary of the blackboard suitable for inclusion in agent context.
   * Keeps within a rough token budget.
   */
  getSummaryForAgent(taskId: string, maxEntries = 5): string {
    const bb = taskService.getBlackboard(taskId);
    if (!bb) return "No blackboard data available.";

    const parts: string[] = [
      `OBJECTIVE: ${bb.objective}`,
      `REQUIREMENTS: ${bb.requirements.slice(0, 3).join("; ") || "none"}`,
    ];

    const topFindings = bb.findings.slice(-maxEntries);
    if (topFindings.length > 0) {
      parts.push(
        "RECENT FINDINGS:\n" +
          topFindings
            .map((f) => `- [${f.agent}] ${f.claim} (confidence: ${f.confidence.toFixed(2)})`)
            .join("\n")
      );
    }

    if (bb.errors.length > 0) {
      parts.push(`ERRORS: ${bb.errors.slice(-3).join("; ")}`);
    }

    if (bb.deviceContext) {
      const devs = bb.deviceContext.availableDevices;
      parts.push(
        `DEVICES: ${devs.length} connected${bb.deviceContext.primaryDeviceId ? ` (primary: ${bb.deviceContext.primaryDeviceId})` : ""}`
      );
    }

    return parts.join("\n\n");
  },
};
