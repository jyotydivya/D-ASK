import { BaseAgent } from "./baseAgent";
import { modelRouter } from "../modelRouter";
import { blackboard } from "../blackboard";
import { browserControlService } from "../../lib/agent/tools/web/browserControl";
import type { AgentContext, AgentResult, AgentType } from "../types";

export class BrowserAgent extends BaseAgent {
  readonly agentType: AgentType = "browser";
  readonly name = "Browser Agent";
  readonly description = "Navigates the web and interacts with web pages using Playwright.";

  async execute(context: AgentContext): Promise<AgentResult> {
    const { taskId, nodeId, objective, nodeDescription } = context;

    this.emitProgress(taskId, nodeId, `Thinking about: "${nodeDescription}"`, 10);

    const availableTools = this.getAvailableTools();
    const systemPrompt = `You are the D-ASK Browser Agent.
Your objective is to fulfill the user's web-related request using the tools provided to you.
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
      return this.success("No browser tools needed.");
    }

    this.emitProgress(taskId, nodeId, `Executing ${toolCalls.length} Browser action(s)...`, 30);
    
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

    this.emitProgress(taskId, nodeId, "Browser tasks completed.", 90);
    
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
      case "browser.navigate":
        await browserControlService.navigate(String(args.url));
        return { navigatedTo: args.url };
      case "browser.click":
        await browserControlService.click(String(args.selector));
        return { clicked: args.selector };
      case "browser.type":
        await browserControlService.type(String(args.selector), String(args.text));
        return { typed: args.text, into: args.selector };
      case "browser.screenshot":
        const base64 = await browserControlService.takeScreenshot();
        return { screenshot_base64: base64 };
      default:
        throw new Error(`BrowserAgent cannot route tool: ${toolName}`);
    }
  }
}
