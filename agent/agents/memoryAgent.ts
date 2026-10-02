import { BaseAgent } from "./baseAgent";
import { modelRouter } from "../modelRouter";
import { blackboard } from "../blackboard";
import { memoryService } from "../../lib/agent/memory/memoryService";
import { embeddingService } from "../../lib/agent/memory/embeddingService";
import type { AgentContext, AgentResult, AgentType } from "../types";

export class MemoryAgent extends BaseAgent {
  readonly agentType: AgentType = "memory";
  readonly name = "Memory Agent";
  readonly description = "Manages long-term memories and user preferences.";

  async execute(context: AgentContext): Promise<AgentResult> {
    const { taskId, nodeId, objective, nodeDescription } = context;

    this.emitProgress(taskId, nodeId, `Thinking about: "${nodeDescription}"`, 10);

    const availableTools = this.getAvailableTools();
    const systemPrompt = `You are the D-ASK Memory Agent.
Your objective is to fulfill the user's memory-related request using the tools provided to you.
You must return a JSON array of tool calls.

Available tools:
${JSON.stringify(availableTools, null, 2)}

Return JSON array of tool calls:
[{ "tool": "tool_name", "arguments": { ... } }]`;

    let toolCalls: any[] = [];
    try {
      toolCalls = await modelRouter.generateStructured<any[]>({
        tier: "standard",
        systemPrompt,
        userPrompt: `OBJECTIVE: "${objective}"\nNODE DESCRIPTION: "${nodeDescription}"`,
        outputSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              arguments: { type: "object" }
            },
            required: ["tool", "arguments"]
          }
        },
      });
    } catch (e) {
      return this.failure("Failed to generate plan: " + String(e));
    }

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return this.success("No memory tools needed.");
    }

    this.emitProgress(taskId, nodeId, `Executing ${toolCalls.length} Memory action(s)...`, 30);
    
    const results = [];
    let progress = 30;
    const progressStep = 60 / toolCalls.length;

    for (const call of toolCalls) {
      const toolName = call.tool;
      const args = call.arguments || {};
      
      this.emitProgress(taskId, nodeId, `Running ${toolName}...`, progress);
      
      try {
        const res = await this.callTool(context, toolName, args);
        results.push({ tool: toolName, success: res.success, result: res.result, error: res.error });
      } catch (e) {
        results.push({ tool: toolName, success: false, error: String(e) });
      }

      progress += progressStep;
    }

    this.emitProgress(taskId, nodeId, "Memory tasks completed.", 90);
    
    const summary = results.map(r => r.success ? `✓ ${r.tool} succeeded` : `✗ ${r.tool} failed${r.error ? `: ${r.error}` : ''}`).join(" | ");
    blackboard.setNodeOutput(taskId, nodeId, { results, summary });

    const allSuccess = results.length > 0 && results.every(r => r.success);
    return allSuccess ? this.success(summary) : this.failure(summary);
  }

  protected override async routeTool(
    toolName: string,
    args: Record<string, unknown>,
    _context: AgentContext
  ): Promise<unknown> {
    switch (toolName) {
      case "memory.store_preference":
        memoryService.storePreference(String(args.key), String(args.value));
        return { status: "success", key: args.key, value: args.value };
      
      case "memory.get_preference":
        const pref = memoryService.getPreference(String(args.key));
        return { key: args.key, value: pref };
      
      case "memory.store_memory":
        const storeText = String(args.text);
        const storeCategory = args.category ? String(args.category) as any : "notes";
        const storeVec = await embeddingService.generateEmbedding(storeText);
        memoryService.storeMemory(storeText, storeVec, storeCategory);
        return { status: "success", text: storeText, category: storeCategory };
      
      case "memory.search_memories":
        const queryText = String(args.query);
        const limit = args.limit ? Number(args.limit) : 5;
        const searchCategory = args.category ? String(args.category) as any : undefined;
        // In case embeddings fail or are missing, we could fallback, but embeddingService is used here
        const queryVec = await embeddingService.generateEmbedding(queryText);
        const results = memoryService.searchMemories(queryVec, limit, searchCategory);
        return { query: queryText, results: results.map(r => ({ text: r.text, category: r.category, similarity: r.similarity })) };
      
      default:
        throw new Error(`MemoryAgent cannot route tool: ${toolName}`);
    }
  }
}
