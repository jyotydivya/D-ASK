// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Confirmation Gate — Smart confirmation for destructive actions
// Ported from Mark-LV core/confirm.py
// Actions with undo → execute immediately.
// Truly irreversible actions → require user confirmation.
// ─────────────────────────────────────────────────────────────────────────────

import { toolRegistry } from "../../../tools/registry";
import type { RiskLevel } from "../../../agent/types";

// Actions that are considered truly irreversible (no undo possible)
const IRREVERSIBLE_TOOLS = new Set([
  "pc.set_power_state",    // sleep/shutdown/restart
  "filesystem.delete",     // delete file (sandbox)
  "file.delete",          // delete file (host)
  "git.push",             // push to remote
  "git.commit",           // commit changes
]);

// Actions that are safe even without undo
const ALWAYS_SAFE_TOOLS = new Set([
  "device.list",
  "device.status",
  "device.screenshot",
  "device.home",
  "pc.get_active_window",
  "pc.list_windows",
  "pc.analyze_screen",
  "pc.find_element",
  "pc.system_status",
  "pc.check_weather",
  "web.search",
  "web.fetch",
  "file.read",
  "file.list",
  "filesystem.read",
  "memory.get_preference",
  "memory.search_memories",
  "git.diff",
  "coding.grep_search",
  "coding.ast_outline",
  "browser.screenshot",
  "monitor.list",
]);

export interface ConfirmationResult {
  allowed: boolean;
  reason: string;
  needsConfirmation: boolean;
  riskLevel: RiskLevel;
}

/**
 * Check whether a tool call should proceed, be confirmed, or be blocked.
 *
 * Logic (from Mark-LV):
 * 1. Always-safe tools → proceed immediately
 * 2. Tools with undo → proceed (user can reverse)
 * 3. Irreversible tools → require confirmation
 * 4. High/critical risk → require confirmation
 * 5. Everything else → proceed
 */
export function checkConfirmation(toolName: string): ConfirmationResult {
  // Always safe → proceed
  if (ALWAYS_SAFE_TOOLS.has(toolName)) {
    return {
      allowed: true,
      reason: "Safe read-only tool.",
      needsConfirmation: false,
      riskLevel: "low",
    };
  }

  // Check registry for risk level
  const def = toolRegistry.get(toolName);
  const riskLevel: RiskLevel = def?.riskLevel ?? "medium";

  // Irreversible actions → must confirm
  if (IRREVERSIBLE_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `"${toolName}" is irreversible and requires user confirmation.`,
      needsConfirmation: true,
      riskLevel,
    };
  }

  // Critical risk → must confirm
  if (riskLevel === "critical") {
    return {
      allowed: false,
      reason: `"${toolName}" has critical risk level and requires confirmation.`,
      needsConfirmation: true,
      riskLevel,
    };
  }

  // High risk → confirm unless registry says no approval needed
  if (riskLevel === "high" && def?.requiresApproval !== false) {
    return {
      allowed: false,
      reason: `"${toolName}" has high risk level.`,
      needsConfirmation: true,
      riskLevel,
    };
  }

  // Everything else → proceed
  return {
    allowed: true,
    reason: "Tool is safe to execute.",
    needsConfirmation: false,
    riskLevel,
  };
}

/**
 * Get a human-readable description of what an action will do.
 * Used in confirmation dialogs.
 */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "pc.set_power_state":
      return `System ${args.state} — this will ${args.state} your computer.`;
    case "filesystem.delete":
    case "file.delete":
      return `Delete file: ${args.path}`;
    case "git.push":
      return `Push commits to ${args.remote || "origin"} / ${args.branch || "main"}`;
    case "git.commit":
      return `Commit changes: "${args.message}"`;
    case "pc.mouse_click":
      return `Click ${args.button || "left"} mouse button at current position`;
    case "pc.type_text":
      return `Type text: "${String(args.text).slice(0, 50)}${String(args.text).length > 50 ? "..." : ""}"`;
    case "pc.hotkey":
      return `Press hotkey: ${Array.isArray(args.keys) ? args.keys.join("+") : args.keys}`;
    default: {
      const def = toolRegistry.get(toolName);
      return def?.description || `Execute ${toolName}`;
    }
  }
}
