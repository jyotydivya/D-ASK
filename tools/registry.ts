// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Tool Registry — All tool definitions and registration
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDefinition, AgentType, RiskLevel } from "../agent/types";

const registry = new Map<string, ToolDefinition>();

function register(def: ToolDefinition): void {
  registry.set(def.name, def);
}

// ── Device Tools ──────────────────────────────────────────────────────────────

register({
  name: "device.list",
  description: "List all connected Android devices. Returns array of DeviceInfo.",
  agentType: "device",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.status",
  description: "Get detailed status of a specific device (battery, currentApp, etc.).",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.connect",
  description: "Connect to a device via wireless ADB at the given IP:port.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: {
      ip: { type: "string" },
      port: { type: "number" },
    },
    required: ["ip"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "device.launch_app",
  description: "Launch an app on the device (youtube, instagram, camera, chrome, etc.).",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: { type: "string" },
      app: { type: "string" },
    },
    required: ["deviceId", "app"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "device.lock",
  description: "Lock (sleep) the device screen.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "device.unlock",
  description: "Wake and unlock the device screen. Optionally provide a PIN.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: { type: "string" },
      pin: { type: "string" },
    },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "device.home",
  description: "Press the Home button on the device.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.screenshot",
  description: "Take a screenshot of the device screen. Returns a URL to the image.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.volume_up",
  description: "Increase device volume by one step.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.volume_down",
  description: "Decrease device volume by one step.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "device.search_youtube",
  description: "Open YouTube on the device and perform a search.",
  agentType: "device",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: { type: "string" },
      query: { type: "string" },
    },
    required: ["deviceId", "query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Web / Research Tools ──────────────────────────────────────────────────────

register({
  name: "web.search",
  description: "Search the web using a query string. Returns top results.",
  agentType: "research",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      maxResults: { type: "number" },
    },
    required: ["query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "web.fetch",
  description: "Fetch and extract readable text content from a URL.",
  agentType: "research",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Browser Tools (Playwright — Phase 5) ─────────────────────────────────────

register({
  name: "browser.navigate",
  description: "Navigate the browser to a URL.",
  agentType: "browser",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  permissions: ["browser"],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "browser.click",
  description: "Click an element on the page by CSS selector.",
  agentType: "browser",
  inputSchema: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  permissions: ["browser"],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "browser.type",
  description: "Type text into a form field by CSS selector.",
  agentType: "browser",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      text: { type: "string" },
    },
    required: ["selector", "text"],
  },
  permissions: ["browser"],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "browser.screenshot",
  description: "Take a screenshot of the current browser page.",
  agentType: "browser",
  inputSchema: { type: "object", properties: {} },
  permissions: ["browser"],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Memory Tools (Phase 4) ───────────────────────────────────────────────────

register({
  name: "memory.store_preference",
  description: "Store a simple key-value preference for the user (e.g., 'favorite_color', 'blue').",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { type: "string" },
    },
    required: ["key", "value"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.get_preference",
  description: "Retrieve a simple key-value preference.",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
    },
    required: ["key"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.store_memory",
  description: "Store a semantic memory (e.g., a fact about the user or a past conversation).",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.search_memories",
  description: "Search semantic memories using a natural language query.",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Coding Tools (Phase 5) ────────────────────────────────────────────────────

register({
  name: "coding.grep_search",
  description: "Search for a string or regex pattern across the workspace.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      isRegex: { type: "boolean" },
      caseInsensitive: { type: "boolean" },
      dir: { type: "string", description: "Relative directory to search in, defaults to project root." },
    },
    required: ["query"],
  },
  permissions: ["sandbox"],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "coding.multi_replace",
  description: "Apply multiple non-contiguous text replacements to a file safely.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      targetFile: { type: "string" },
      chunks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            startLine: { type: "number" },
            endLine: { type: "number" },
            targetContent: { type: "string" },
            replacementContent: { type: "string" },
            allowMultiple: { type: "boolean" }
          },
          required: ["startLine", "endLine", "targetContent", "replacementContent"]
        }
      },
    },
    required: ["targetFile", "chunks"],
  },
  permissions: ["sandbox"],
  riskLevel: "medium",
  requiresApproval: true,
});

register({
  name: "coding.ast_outline",
  description: "Get a high-level AST outline (classes, interfaces, functions) of a TypeScript/JavaScript file.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      targetFile: { type: "string" },
    },
    required: ["targetFile"],
  },
  permissions: ["sandbox"],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Filesystem Tools (sandbox only — Phase 7) ─────────────────────────────────

register({
  name: "filesystem.read",
  description: "Read a file from the sandbox workspace.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  permissions: ["sandbox"],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "filesystem.write",
  description: "Write content to a file in the sandbox workspace.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  permissions: ["sandbox"],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "filesystem.delete",
  description: "Delete a file from the sandbox workspace.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  permissions: ["sandbox"],
  riskLevel: "high",
  requiresApproval: true,
});

// ── Terminal Tools (sandbox only — Phase 7) ────────────────────────────────────

register({
  name: "terminal.execute",
  description: "Execute a shell command inside the sandbox. Returns stdout/stderr.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
    },
    required: ["command"],
  },
  permissions: ["sandbox"],
  riskLevel: "medium",
  requiresApproval: false,
});

// ── Git Tools (sandbox only — Phase 7) ────────────────────────────────────────

register({
  name: "git.diff",
  description: "Get the current git diff in the sandbox workspace.",
  agentType: "coding",
  inputSchema: { type: "object", properties: {} },
  permissions: ["sandbox"],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "git.commit",
  description: "Commit staged changes with a message.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  permissions: ["sandbox"],
  riskLevel: "high",
  requiresApproval: true,
});

register({
  name: "git.push",
  description: "Push commits to a remote git repository.",
  agentType: "coding",
  inputSchema: {
    type: "object",
    properties: {
      remote: { type: "string" },
      branch: { type: "string" },
    },
  },
  permissions: ["sandbox"],
  riskLevel: "critical",
  requiresApproval: true,
});

// ── PC Tools (Windows PC Agent) ────────────────────────────────────────────────

register({
  name: "pc.launch_application",
  description: "Launch a Windows application (e.g. calculator, chrome, paint).",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      application: { type: "string" },
      appName: { type: "string" }, // Fallback for LLMs
    },
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.close_application",
  description: "Close a running Windows application by name.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      application: { type: "string" },
      appName: { type: "string" }, // Fallback
    },
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.get_active_window",
  description: "Get the title of the currently focused active window on the PC.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.list_windows",
  description: "List all currently open main windows on the PC.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.mouse_move",
  description: "Move the mouse cursor to absolute coordinates x, y.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["x", "y"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.mouse_click",
  description: "Click the mouse at the current position.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      button: { type: "string", enum: ["left", "right", "middle"] },
      clicks: { type: "number" },
    },
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: true,
});

register({
  name: "pc.type_text",
  description: "Type a string of text using the keyboard.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: true,
});

register({
  name: "pc.press_key",
  description: "Press a specific key (e.g. 'enter', 'tab', 'escape').",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
    },
    required: ["key"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.hotkey",
  description: "Press a combination of keys (e.g. ['ctrl', 'c']).",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      keys: { type: "array", items: { type: "string" } },
    },
    required: ["keys"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: true,
});

register({
  name: "pc.analyze_screen",
  description: "Take a screenshot and ask the vision model a question about the screen (e.g. 'Read the text in the active window').",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.find_element",
  description: "Locate a UI element on the screen. Returns { x, y } coordinates.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Visual description of the element to find." },
    },
    required: ["description"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Filesystem Tools (Host PC) ────────────────────────────────────────────────

register({
  name: "file.read",
  description: "Read a local file from the PC.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "file.write",
  description: "Write content to a local file on the PC.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  permissions: [],
  riskLevel: "high",
  requiresApproval: true,
});

register({
  name: "file.list",
  description: "List files in a directory on the PC.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "file.copy",
  description: "Copy a local file on the PC.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { sourcePath: { type: "string" }, destPath: { type: "string" } },
    required: ["sourcePath", "destPath"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

register({
  name: "file.move",
  description: "Move a local file on the PC.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { sourcePath: { type: "string" }, destPath: { type: "string" } },
    required: ["sourcePath", "destPath"],
  },
  permissions: [],
  riskLevel: "medium",
  requiresApproval: false,
});

// ── Mark 39 Parity Tools (New OS & App Integrations) ───────────────────────────

register({
  name: "pc.set_power_state",
  description: "Change system power state (sleep, shutdown, restart, lock).",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { state: { type: "string", enum: ["sleep", "shutdown", "restart", "lock"] } },
    required: ["state"],
  },
  permissions: [],
  riskLevel: "high",
  requiresApproval: true,
});

register({
  name: "pc.manage_window",
  description: "Manage the active window (minimize, maximize, close).",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { action: { type: "string", enum: ["minimize", "maximize", "close"] } },
    required: ["action"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.volume_up",
  description: "Increase system volume.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { steps: { type: "number" } },
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.volume_down",
  description: "Decrease system volume.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { steps: { type: "number" } },
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.toggle_mute",
  description: "Toggle system audio mute.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.set_brightness",
  description: "Set screen brightness (0-100). Only works on built-in displays (laptops).",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { level: { type: "number" } },
    required: ["level"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.youtube_play",
  description: "Search and play a video on YouTube.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.web_search",
  description: "Quick web search using DuckDuckGo.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.check_weather",
  description: "Check weather for a given location or current location.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { location: { type: "string" } },
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.set_reminder",
  description: "Set a desktop reminder notification in N minutes.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "number" },
      message: { type: "string" }
    },
    required: ["minutes", "message"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.send_whatsapp",
  description: "Draft a WhatsApp message to be sent.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.send_telegram",
  description: "Draft a Telegram message to be sent.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.launch_steam",
  description: "Open Steam.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.launch_epic",
  description: "Open Epic Games.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.system_status",
  description: "Get comprehensive system status (CPU, RAM, Disk, GPU, Network, Battery).",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.top_processes",
  description: "Get top running processes by CPU or Memory usage.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: {
      sortBy: { type: "string", enum: ["cpu", "memory"] },
      limit: { type: "number" }
    }
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.network_info",
  description: "Get network connectivity info (Local IPs, WiFi SSID).",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.undo",
  description: "Undo the last destructive action.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "pc.undo_history",
  description: "View the available undo history.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "monitor.add",
  description: "Add a topic to the background news monitor.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "monitor.remove",
  description: "Remove a topic from the background news monitor.",
  agentType: "pc",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "monitor.list",
  description: "List currently monitored topics.",
  agentType: "pc",
  inputSchema: { type: "object", properties: {} },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.store_preference",
  description: "Store a key-value user preference.",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { type: "string" }
    },
    required: ["key", "value"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.get_preference",
  description: "Get a key-value user preference.",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" }
    },
    required: ["key"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.store_memory",
  description: "Store a semantic memory for the user.",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      category: { type: "string", enum: ["identity", "preferences", "projects", "relationships", "wishes", "notes", "session"] }
    },
    required: ["text"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

register({
  name: "memory.search_memories",
  description: "Search user memories by keyword (fallback for semantic).",
  agentType: "memory",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
      category: { type: "string", enum: ["identity", "preferences", "projects", "relationships", "wishes", "notes", "session"] }
    },
    required: ["query"]
  },
  permissions: [],
  riskLevel: "low",
  requiresApproval: false,
});

// ── Registry API ──────────────────────────────────────────────────────────────

export const toolRegistry = {
  get(name: string): ToolDefinition | null {
    return registry.get(name) ?? null;
  },

  getAll(): ToolDefinition[] {
    return Array.from(registry.values());
  },

  getForAgent(agentType: AgentType): ToolDefinition[] {
    return Array.from(registry.values()).filter(
      (t) => t.agentType === agentType
    );
  },

  getByRiskLevel(level: RiskLevel): ToolDefinition[] {
    return Array.from(registry.values()).filter((t) => t.riskLevel === level);
  },

  exists(name: string): boolean {
    return registry.has(name);
  },
};
