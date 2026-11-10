// The agent host's registry: the default tools plus the host-only capabilities (local browser, local memory). Kept out of
// defaults.ts on purpose: the Next.js app imports defaults.ts and must never bundle Playwright, the browser profile or the
// memory database (they belong to the agent host process only).

import { createDefaultRegistry, type DefaultRegistryOptions } from "./defaults";
import { createBrowserTools } from "./tools/browser";
import { createMemoryTools } from "./tools/memory";
import type { BrowserEngine, BrowserSessions } from "./browser/playwrightEngine";
import type { MemoryStore } from "./memory/memoryStore";
import type { ToolRegistry } from "./toolRegistry";

export interface HostRegistryOptions extends DefaultRegistryOptions {
  /** Browser stage 1: read pages the user names in local Chromium. Absent: the browser tools do not exist. */
  browser?: BrowserEngine;
  /** Browser stage 2: per-task sessions; the action tools exist only with these AND the desktop bridge (daemon approvals). */
  browserSessions?: BrowserSessions;
  /** Local persistent memory. Absent: the memory tools do not exist. */
  memory?: MemoryStore;
}

export function createHostRegistry(workspaceRoot?: string, options: HostRegistryOptions = {}): ToolRegistry {
  const registry = createDefaultRegistry(workspaceRoot, options);
  if (options.memory) for (const tool of createMemoryTools(options.memory)) registry.register(tool);
  if (options.browser) {
    const actions = options.browserSessions && options.desktop ? { sessions: options.browserSessions, bridge: options.desktop } : undefined;
    for (const tool of createBrowserTools(options.browser, actions)) registry.register(tool);
  }
  return registry;
}
