// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Planner — Converts natural-language objectives into a Task DAG
// ─────────────────────────────────────────────────────────────────────────────

import { modelRouter } from "./modelRouter";
import { taskService } from "../services/taskService";
import type {
  ExecutionPlan,
  PlannerOutput,
  PlannerNode,
  AgentType,
} from "./types";

const PLANNER_SYSTEM_PROMPT = `You are the D-ASK Task Planner. Your job is to decompose a user objective into a minimal, efficient sequence of task nodes that specialized agents will execute.

AVAILABLE AGENT TYPES:
- "pc"       : Controls the local Windows PC (launch apps like Notepad/Chrome/Paint, close apps, list windows, mouse, keyboard, local files, system settings). Always use "pc" for PC software and OS commands.
- "browser"  : Navigates websites, clicks, types, extracts web pages (Playwright)
- "coding"   : Reads/writes project code, AST analysis, search files, runs tests
- "data"     : Analyzes datasets, runs Python, generates visualizations
- "device"   : ONLY for physical Android phones connected via ADB. Do NOT use unless the user explicitly specifies "phone" or "android".
- "research" : Searches the web and extracts information
- "verifier" : Checks if requirements were met, validates outputs (ONLY for the final verification step)

RULES:
1. Keep the plan minimal (typically 1 to 4 steps).
2. For ANY action on this Windows computer (opening apps, modifying files, taking screenshots, controlling settings), set agentType: "pc".
3. NEVER assign agentType: "verifier" to an execution step. "verifier" is ONLY for the final verification check.
4. Set dependencies correctly — a node can only run after all its dependencies complete.
5. Limit to 8 nodes maximum.
6. Set requiresApproval: true ONLY for destructive or irreversible actions.

EXAMPLES:
User: "Open Notepad on my PC"
→ nodes:
  - id: "open_notepad", name: "launch_notepad", description: "Launch Notepad on Windows", agentType: "pc", dependencies: [], estimatedDurationMs: 1500, requiresApproval: false
  - id: "verify_notepad", name: "verify_notepad", description: "Verify Notepad window is open", agentType: "verifier", dependencies: ["open_notepad"], estimatedDurationMs: 1000, requiresApproval: false

User: "Research the latest AI news and summarize it"
→ nodes:
  - id: "search_news", name: "search_web", description: "Search latest AI news", agentType: "research", dependencies: [], estimatedDurationMs: 3000, requiresApproval: false
  - id: "verify_summary", name: "verify_summary", description: "Verify summary is complete", agentType: "verifier", dependencies: ["search_news"], estimatedDurationMs: 1000, requiresApproval: false

Be concise. Return valid JSON matching the schema.`;

function buildPlannerSchema() {
  return {
    type: "object",
    properties: {
      objective: { type: "string" },
      requirements: {
        type: "array",
        items: { type: "string" },
      },
      successCriteria: {
        type: "array",
        items: { type: "string" },
      },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            agentType: {
              type: "string",
              enum: ["device", "research", "browser", "coding", "data", "pc", "verifier"],
            },
            dependencies: {
              type: "array",
              items: { type: "string" },
            },
            estimatedDurationMs: { type: "number" },
            requiresApproval: { type: "boolean" },
          },
          required: ["id", "name", "description", "agentType", "dependencies", "estimatedDurationMs", "requiresApproval"],
        },
      },
    },
    required: ["objective", "requirements", "successCriteria", "nodes"],
  };
}

export class Planner {
  /**
   * Create an initial execution plan for an objective.
   */
  async createPlan(taskId: string, objective: string): Promise<ExecutionPlan> {
    const plannerOutput = await modelRouter.generateStructured<PlannerOutput>({
      tier: "reasoning",
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: `Create an execution plan for this objective:\n\n"${objective}"`,
      outputSchema: buildPlannerSchema(),
      taskId,
    });

    // Validate and normalize the planner output
    const validatedNodes = this.validateNodes(plannerOutput.nodes ?? []);

    const planId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const plan: ExecutionPlan = {
      id: planId,
      taskId,
      objective: plannerOutput.objective ?? objective,
      requirements: plannerOutput.requirements ?? [],
      successCriteria: plannerOutput.successCriteria ?? [],
      nodes: validatedNodes.map((n) => ({
        id: n.id,
        taskId,
        name: n.name,
        description: n.description,
        agentType: n.agentType as AgentType,
        status: "pending",
        dependencies: n.dependencies,
        attempts: 0,
        maxAttempts: 3,
      })),
      createdAt: new Date(),
    };

    // Persist nodes to task service
    taskService.setNodesFromPlan(plan);
    taskService.updateBlackboard(taskId, {
      requirements: plan.requirements,
      successCriteria: plan.successCriteria,
    });
    taskService.updateTask(taskId, { planId });

    return plan;
  }

  /**
   * Replan after a failure — only replanning the failed/pending nodes.
   * Completed nodes are kept as-is.
   */
  async replan(
    taskId: string,
    objective: string,
    failedNodeIds: string[],
    blackboardSummary: string
  ): Promise<PlannerNode[]> {
    const existingNodes = taskService.getNodes(taskId);
    const completedNodes = existingNodes.filter((n) => n.status === "completed");
    const completedIds = completedNodes.map((n) => n.id);

    const userPrompt = `
Original objective: "${objective}"

Already completed steps: ${completedIds.length > 0 ? completedIds.join(", ") : "none"}

Failed steps: ${failedNodeIds.join(", ")}

Blackboard context:
${blackboardSummary}

Create NEW replacement nodes for the failed steps. 
Do NOT re-create the completed steps.
The new nodes may add dependencies on completed steps.
    `.trim();

    const replanned = await modelRouter.generateStructured<{ nodes: PlannerNode[] }>({
      tier: "reasoning",
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt,
      outputSchema: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: buildPlannerSchema().properties.nodes.items,
          },
        },
        required: ["nodes"],
      },
      taskId,
    });

    const validated = this.validateNodes(replanned.nodes ?? []);
    return validated;
  }

  /**
   * Validate planner output nodes — ensure IDs are unique, types are valid, etc.
   */
  private validateNodes(nodes: PlannerNode[]): PlannerNode[] {
    const validAgentTypes = new Set<AgentType>([
      "pc", "coding", "browser", "device", "research", "data", "memory", "verifier",
    ]);
    const seenIds = new Set<string>();
    const validNodes: PlannerNode[] = [];

    for (const node of nodes) {
      // Ensure ID is unique and valid
      let id = (node.id ?? "").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
      if (!id) id = `node_${validNodes.length + 1}`;
      while (seenIds.has(id)) id = `${id}_${validNodes.length}`;
      seenIds.add(id);

      // Ensure agent type is valid
      const agentType = validAgentTypes.has(node.agentType as AgentType)
        ? (node.agentType as AgentType)
        : "verifier";

      // Ensure dependencies reference known IDs
      const deps = (node.dependencies ?? []).filter((d) => seenIds.has(d) || nodes.some((n) => n.id === d));

      validNodes.push({
        id,
        name: node.name ?? id,
        description: node.description ?? id,
        agentType,
        dependencies: deps,
        estimatedDurationMs: node.estimatedDurationMs ?? 5000,
        requiresApproval: node.requiresApproval ?? false,
      });
    }

    return validNodes;
  }
}

export const planner = new Planner();
