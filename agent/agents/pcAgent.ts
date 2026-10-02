// ─────────────────────────────────────────────────────────────────────────────
// D-ASK PC Agent — Controls the Windows PC using the Tool Router abstraction
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAgent } from "./baseAgent";
import { modelRouter } from "../modelRouter";
import { blackboard } from "../blackboard";
import { pcControlService } from "../../lib/agent/tools/desktop/pcControl";
import { mouseKeyboardService } from "../../lib/agent/tools/desktop/mouseKeyboard";
import { visionControlService } from "../../lib/agent/tools/desktop/visionControl";
import { fileToolsService } from "../../lib/agent/tools/system/fileTools";
import { systemSettingsService } from "../../lib/agent/tools/desktop/systemSettings";
import { youtubePlayerService } from "../../lib/agent/tools/desktop/youtubePlayer";
import { webToolsService } from "../../lib/agent/tools/desktop/webTools";
import { reminderService } from "../../lib/agent/tools/desktop/reminder";
import { messagingService } from "../../lib/agent/tools/desktop/messaging";
import { systemMonitorService } from "../../lib/agent/tools/system/systemMonitor";
import { backgroundMonitorService } from "../../lib/agent/tools/system/backgroundMonitor";
import { popUndo, getUndoHistory } from "../../lib/agent/tools/system/undoStack";
import type { AgentContext, AgentResult, AgentType } from "../types";
import { gameUpdaterService } from "@/lib/agent/tools/desktop/gameUpdater";

export class PCAgent extends BaseAgent {
  readonly agentType: AgentType = "pc";
  readonly name = "PC Agent";
  readonly description = "Controls your local Windows PC via high-level tools.";

  async execute(context: AgentContext): Promise<AgentResult> {
    const { taskId, nodeId, objective, nodeDescription } = context;

    this.emitProgress(taskId, nodeId, `Thinking about: "${nodeDescription}"`, 10);

    // Provide the LLM with the available PC tools
    const availableTools = this.getAvailableTools();
    const systemPrompt = `You are the D-ASK PC Agent running on a Windows machine.
Your objective is to fulfill the user's request using the tools provided to you.
You must return a JSON object with a "tools" array of tool calls.

Available tools:
${JSON.stringify(availableTools, null, 2)}

Return JSON format:
{
  "tools": [
    { "tool": "tool_name", "arguments": { "param": "value" } }
  ]
}`;

    let toolCalls: any[] = [];
    try {
      const rawResult = await modelRouter.generateStructured<any>({
        tier: "standard",
        systemPrompt,
        userPrompt: `OBJECTIVE: "${objective}"\nNODE DESCRIPTION: "${nodeDescription}"`,
        outputSchema: {
          type: "object",
          properties: {
            tools: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  arguments: { type: "object" }
                },
                required: ["tool", "arguments"]
              }
            }
          },
          required: ["tools"]
        },
      });

      if (Array.isArray(rawResult)) {
        toolCalls = rawResult;
      } else if (rawResult && typeof rawResult === "object") {
        toolCalls = rawResult.tools || rawResult.toolCalls || rawResult.actions || [];
        if (!Array.isArray(toolCalls) && typeof toolCalls === "object") {
          toolCalls = Object.values(toolCalls);
        }
      }
    } catch (e) {
      return this.failure("Failed to generate plan: " + String(e));
    }

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return this.success("No PC tools needed.");
    }

    this.emitProgress(taskId, nodeId, `Executing ${toolCalls.length} PC action(s)...`, 30);

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

    this.emitProgress(taskId, nodeId, "PC tasks completed.", 90);

    // Save to blackboard
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
      // System / Window tools
      case "pc.launch_application":
        return await pcControlService.launchApplication(String(args.application ?? args.appName ?? ""));
      case "pc.close_application":
        return await pcControlService.closeApplication(String(args.application ?? args.appName ?? ""));
      case "pc.get_active_window":
        return await pcControlService.getActiveWindow();
      case "pc.list_windows":
        return await pcControlService.listWindows();

      // Vision tools
      case "pc.analyze_screen":
        return await visionControlService.analyzeScreen(String(args.query));
      case "pc.find_element":
        return await visionControlService.findElementOnScreen(String(args.description));

      // Mouse tools
      case "pc.mouse_move":
        return await mouseKeyboardService.moveMouse(Number(args.x), Number(args.y));
      case "pc.mouse_click":
        return await mouseKeyboardService.click(args.button as any, Number(args.clicks ?? 1));

      // Keyboard tools
      case "pc.type_text":
        return await mouseKeyboardService.typeText(String(args.text));
      case "pc.press_key":
        return await mouseKeyboardService.pressKey(String(args.key));
      case "pc.hotkey":
        return await mouseKeyboardService.hotkey(args.keys as string[]);

      // File tools
      case "file.read":
        return await fileToolsService.readFile(String(args.path));
      case "file.write":
        return await fileToolsService.writeFile(String(args.path), String(args.content));
      case "file.list":
        return await fileToolsService.listFiles(String(args.path));
      case "file.copy":
        return await fileToolsService.copyFile(String(args.sourcePath), String(args.destPath));
      case "file.move":
        return await fileToolsService.moveFile(String(args.sourcePath), String(args.destPath));
      case "file.delete":
        return await fileToolsService.deleteFile(String(args.path));

      // New OS tools
      case "pc.set_power_state":
        return await pcControlService.setPowerState(args.state as any);
      case "pc.manage_window":
        return await pcControlService.manageActiveWindow(args.action as any);
      case "pc.volume_up":
        return await systemSettingsService.volumeUp(Number(args.steps ?? 5));
      case "pc.volume_down":
        return await systemSettingsService.volumeDown(Number(args.steps ?? 5));
      case "pc.toggle_mute":
        return await systemSettingsService.toggleMute();
      case "pc.set_brightness":
        return await systemSettingsService.setBrightness(Number(args.level ?? 100));

      // App integrations
      case "pc.youtube_play":
        return await youtubePlayerService.searchAndPlay(String(args.query));
      case "pc.web_search":
        return await webToolsService.searchWeb(String(args.query));
      case "pc.check_weather":
        return await webToolsService.checkWeather(args.location ? String(args.location) : undefined);
      case "pc.set_reminder":
        return await reminderService.setReminder(Number(args.minutes), String(args.message));
      case "pc.send_whatsapp":
        return await messagingService.sendWhatsApp(String(args.message));
      case "pc.send_telegram":
        return await messagingService.sendTelegram(String(args.message));
      case "pc.launch_steam":
        return await gameUpdaterService.launchSteam();
      case "pc.launch_epic":
        return await gameUpdaterService.launchEpicGames();

      // Monitoring and System Status tools
      case "pc.system_status":
        return await systemMonitorService.getSystemStatus();
      case "pc.top_processes":
        return await systemMonitorService.getTopProcesses(args.sortBy as any, Number(args.limit ?? 10));
      case "pc.network_info":
        return await systemMonitorService.getNetworkInfo();
      case "monitor.add":
        return backgroundMonitorService.addTopic(String(args.topic));
      case "monitor.remove":
        return backgroundMonitorService.removeTopic(String(args.topic));
      case "monitor.list":
        return backgroundMonitorService.listTopics();
      case "pc.undo":
        return await popUndo();
      case "pc.undo_history":
        return getUndoHistory();

      default:
        throw new Error(`PCAgent cannot route tool: ${toolName}`);
    }
  }
}
