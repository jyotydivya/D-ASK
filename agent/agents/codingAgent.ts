import { BaseAgent } from "./baseAgent";
import { modelRouter } from "../modelRouter";
import { blackboard } from "../blackboard";
import { grepSearch } from "../../lib/agent/tools/coding/fileSearch";
import { multiReplace, ReplacementChunk } from "../../lib/agent/tools/coding/fileEditor";
import { getFileOutline } from "../../lib/agent/tools/coding/astService";
import path from "path";
import fs from "fs";
import type { AgentContext, AgentResult, AgentType } from "../types";

export class CodingAgent extends BaseAgent {
  readonly agentType: AgentType = "coding";
  readonly name = "Coding Agent";
  readonly description = "AI Coding assistant for semantic search, AST parsing, and codebase modifications.";

  async execute(context: AgentContext): Promise<AgentResult> {
    const { taskId, nodeId, objective, nodeDescription } = context;

    this.emitProgress(taskId, nodeId, `Thinking about: "${nodeDescription}"`, 10);

    const availableTools = this.getAvailableTools();
    const systemPrompt = `You are the D-ASK Coding Agent.
Your objective is to fulfill the user's coding-related request using the tools provided to you.
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
      return this.success("No coding tools needed.");
    }

    this.emitProgress(taskId, nodeId, `Executing ${toolCalls.length} Coding action(s)...`, 30);
    
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

    this.emitProgress(taskId, nodeId, "Coding tasks completed.", 90);
    
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
      case "coding.grep_search": {
        const query = String(args.query);
        const isRegex = Boolean(args.isRegex);
        const caseInsensitive = Boolean(args.caseInsensitive);
        // By default search from process.cwd()
        const rootDir = typeof args.dir === "string" ? path.resolve(process.cwd(), args.dir) : process.cwd();
        const searchRes = await grepSearch(rootDir, query, isRegex, caseInsensitive);
        return { count: searchRes.length, results: searchRes };
      }
      
      case "coding.multi_replace": {
        const targetFile = String(args.targetFile);
        const chunks = args.chunks as ReplacementChunk[];
        const absolutePath = path.resolve(process.cwd(), targetFile);
        const replaceRes = await multiReplace(absolutePath, chunks);
        if (!replaceRes.success) throw new Error(replaceRes.message);
        return { status: "success", message: replaceRes.message };
      }
      
      case "coding.ast_outline": {
        const targetFile = String(args.targetFile);
        const absolutePath = path.resolve(process.cwd(), targetFile);
        const outline = await getFileOutline(absolutePath);
        return { file: targetFile, outline };
      }
      
      // Also support the old standard filesystem ones since CodingAgent replaces PCAgent for "coding"
      case "filesystem.read": {
        const p = path.resolve(process.cwd(), String(args.path));
        return { content: await fs.promises.readFile(p, "utf-8") };
      }

      case "filesystem.write": {
        const p = path.resolve(process.cwd(), String(args.path));
        await fs.promises.writeFile(p, String(args.content), "utf-8");
        return { status: "success", path: p };
      }

      case "filesystem.delete": {
        const p = path.resolve(process.cwd(), String(args.path));
        await fs.promises.unlink(p);
        return { status: "success", path: p };
      }

      default:
        throw new Error(`CodingAgent cannot route tool: ${toolName}`);
    }
  }
}
