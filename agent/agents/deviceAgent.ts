// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Device Agent
// Wraps DeviceService as an intelligent agent that understands device goals.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAgent } from "./baseAgent";
import { deviceService } from "../../tools/device/deviceService";
import { blackboard } from "../blackboard";
import { modelRouter } from "../modelRouter";
import type { AgentContext, AgentResult, AgentType } from "../types";

export class DeviceAgent extends BaseAgent {
  readonly agentType: AgentType = "device";
  readonly name = "Device Agent";
  readonly description = "Controls Android devices via ADB. Discovers, connects, and executes device actions.";

  async execute(context: AgentContext): Promise<AgentResult> {
    const { taskId, nodeId, nodeDescription, dependencyOutputs } = context;

    this.emitProgress(taskId, nodeId, `Analyzing device task: "${nodeDescription}"`, 5);

    // 1. Ensure we have connected devices
    this.emitProgress(taskId, nodeId, "Scanning for connected devices...", 15);
    const { devices, connected } = await deviceService.listDevices();
    const connectedDevices = devices.filter((d) => d.status === "CONNECTED" && d.isPhysical);

    // Update blackboard with device context
    blackboard.setDeviceContext(taskId, connectedDevices, connectedDevices[0]?.id);

    if (connectedDevices.length === 0) {
      return this.failure(
        "NO CONNECTED DEVICES FOUND. Please connect a phone via USB or wireless ADB.",
        "No device available to execute task."
      );
    }

    this.emitProgress(taskId, nodeId, `Found ${connectedDevices.length} device(s). Determining action...`, 30);

    // 2. Use the model to determine what device action(s) to perform
    const primaryDevice = connectedDevices[0]!;
    const depContext = Object.values(dependencyOutputs).length > 0
      ? `\nPrevious steps produced: ${JSON.stringify(dependencyOutputs, null, 2).slice(0, 500)}`
      : "";

    const actionPlan = await modelRouter.generateStructured<DeviceActionPlan>({
      tier: "standard",
      systemPrompt: DEVICE_AGENT_SYSTEM_PROMPT,
      userPrompt: `
TASK NODE: ${nodeDescription}
PRIMARY DEVICE: ${primaryDevice.id} (${primaryDevice.model}, battery: ${primaryDevice.batteryLevel}%, current app: ${primaryDevice.currentApp})
ALL CONNECTED DEVICES: ${connectedDevices.map((d) => `${d.id} (${d.model})`).join(", ")}
BLACKBOARD SUMMARY: ${blackboard.getSummaryForAgent(taskId)}${depContext}

Determine which device action(s) to execute and in what order.
Respond with a structured action plan.
      `.trim(),
      outputSchema: DEVICE_ACTION_PLAN_SCHEMA,
    });

    this.emitProgress(taskId, nodeId, `Executing: ${actionPlan.summary}`, 50);

    // 3. Execute each action
    const results: string[] = [];
    let lastError: string | undefined;

    for (const action of actionPlan.actions) {
      this.emitProgress(taskId, nodeId, `Running: ${action.tool}`, 60);

      const toolResult = await this.callTool(context, action.tool, {
        deviceId: action.deviceId ?? primaryDevice.id,
        ...action.args,
      });

      if (!toolResult.success) {
        if (toolResult.approvalId) {
          return {
            status: "needs_approval",
            summary: `Awaiting approval for ${action.tool}`,
            findings: [],
            artifacts: [],
            nextActions: [],
            toolCallIds: [],
          };
        }
        lastError = toolResult.error;
        results.push(`FAILED: ${action.tool} — ${toolResult.error}`);
        if (action.critical) break; // stop on critical step failure
      } else {
        results.push(`✓ ${action.tool}: ${String(toolResult.result).slice(0, 100)}`);
      }
    }

    this.emitProgress(taskId, nodeId, "Device actions complete. Verifying state...", 90);

    // 4. Take a screenshot for verification if requested
    let screenshotUrl: string | undefined;
    if (actionPlan.captureScreenshot) {
      try {
        screenshotUrl = await deviceService.takeScreenshot(primaryDevice.id);
      } catch { /* non-critical */ }
    }

    if (lastError && results.every((r) => r.startsWith("FAILED"))) {
      return this.failure(lastError, results.join(" | "));
    }

    const summary = results.join(" | ");
    const artifacts = screenshotUrl
      ? [blackboard.addArtifact(taskId, {
          taskId,
          nodeId,
          type: "screenshot",
          name: `Device screenshot — ${new Date().toISOString()}`,
          url: screenshotUrl,
        })]
      : [];

    blackboard.setNodeOutput(taskId, nodeId, { summary, screenshotUrl, deviceId: primaryDevice.id });

    return this.success(summary, { artifacts });
  }

  protected override async routeTool(
    toolName: string,
    args: Record<string, unknown>,
    _context: AgentContext
  ): Promise<unknown> {
    const deviceId = String(args.deviceId ?? "");

    switch (toolName) {
      case "device.list": {
        const { devices, connected } = await deviceService.listDevices();
        return { devices, connected };
      }
      case "device.status":
        return deviceService.getDeviceStatus(deviceId);
      case "device.connect":
        return deviceService.connectDevice(String(args.ip), Number(args.port ?? 5555));
      case "device.launch_app":
        return deviceService.launchApp(deviceId, String(args.app));
      case "device.lock":
        return deviceService.lockDevice(deviceId);
      case "device.unlock":
        return deviceService.unlockDevice(deviceId, args.pin ? String(args.pin) : undefined);
      case "device.home":
        return deviceService.goHome(deviceId);
      case "device.screenshot":
        return deviceService.takeScreenshot(deviceId);
      case "device.volume_up":
        return deviceService.volumeUp(deviceId);
      case "device.volume_down":
        return deviceService.volumeDown(deviceId);
      case "device.search_youtube":
        return deviceService.searchYouTube(deviceId, String(args.query));
      default:
        throw new Error(`Device agent does not support tool: ${toolName}`);
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeviceAction {
  tool: string;
  deviceId?: string;
  args: Record<string, unknown>;
  critical: boolean; // if true, stop on failure
}

interface DeviceActionPlan {
  summary: string;
  actions: DeviceAction[];
  captureScreenshot: boolean;
}

// ── Prompts & Schemas ─────────────────────────────────────────────────────────

const DEVICE_AGENT_SYSTEM_PROMPT = `You are the D-ASK Device Agent. You control Android devices via ADB.

Available tools:
- device.list: List connected devices (no args)
- device.status: Get device status (deviceId)
- device.launch_app: Launch an app (deviceId, app: 'youtube'|'instagram'|'camera'|'chrome')
- device.lock: Lock device screen (deviceId)
- device.unlock: Unlock device screen (deviceId, pin?)
- device.home: Press home button (deviceId)
- device.screenshot: Take screenshot (deviceId)
- device.volume_up: Increase volume (deviceId)
- device.volume_down: Decrease volume (deviceId)
- device.search_youtube: YouTube search (deviceId, query)

Rules:
- Always use the most appropriate tool for the task
- Include deviceId in every action
- Set critical: true for the main action the task depends on
- Set captureScreenshot: true when you need to verify the outcome
- Do NOT create more than 5 actions per plan`;

const DEVICE_ACTION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          deviceId: { type: "string" },
          args: { type: "object" },
          critical: { type: "boolean" },
        },
        required: ["tool", "args", "critical"],
      },
    },
    captureScreenshot: { type: "boolean" },
  },
  required: ["summary", "actions", "captureScreenshot"],
};
