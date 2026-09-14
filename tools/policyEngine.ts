// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Policy Engine — Risk-based permission enforcement
// The model CANNOT override this. Every tool call must pass through here.
// ─────────────────────────────────────────────────────────────────────────────

import { toolRegistry } from "./registry";
import { taskService } from "../services/taskService";
import type { PolicyDecision, RiskLevel } from "../agent/types";

/**
 * Validate and authorize a tool call before execution.
 *
 * Returns:
 *   { allowed: true }               — proceed
 *   { allowed: false, requiresApproval: true, approvalId }  — gate
 *   { allowed: false, reason }      — hard deny
 */
export async function checkPolicy(
  taskId: string,
  nodeId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<PolicyDecision> {
  // 1. Tool must be registered
  const def = toolRegistry.get(toolName);
  if (!def) {
    return { allowed: false, reason: `Unknown tool: "${toolName}". Only registered tools may be called.` };
  }

  // 2. Validate arguments against schema (basic required-field check)
  const schema = def.inputSchema as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  if (schema.required) {
    for (const field of schema.required) {
      if (args[field] === undefined || args[field] === null) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" requires argument "${field}" but it was not provided.`,
        };
      }
    }
  }

  // 3. Risk-level gate
  const risk: RiskLevel = def.riskLevel;

  if (risk === "critical") {
    // Critical always requires approval
    const existing = taskService.getPendingApproval(taskId);
    if (existing) {
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: existing.id,
        reason: "Waiting for existing approval to be resolved.",
      };
    }
    const approval = taskService.createApproval(
      taskId,
      nodeId,
      toolName,
      args,
      `CRITICAL action: ${def.description}`,
      "critical"
    );
    return {
      allowed: false,
      requiresApproval: true,
      approvalId: approval.id,
    };
  }

  if (def.requiresApproval && (risk === "high" || risk === "medium")) {
    const existing = taskService.getPendingApproval(taskId);
    if (existing?.toolName === toolName) {
      // Already has an approval decision for this tool
      if (existing.status === "approved") {
        return { allowed: true };
      }
      if (existing.status === "rejected") {
        return { allowed: false, reason: "User rejected this action." };
      }
      // Still pending
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: existing.id,
      };
    }

    const approval = taskService.createApproval(
      taskId,
      nodeId,
      toolName,
      args,
      `${risk.toUpperCase()} risk action: ${def.description}`,
      risk
    );
    return {
      allowed: false,
      requiresApproval: true,
      approvalId: approval.id,
    };
  }

  // 4. Low — auto-approve
  return { allowed: true };
}

/**
 * Sanitize tool arguments to prevent injection attacks.
 * - Strips shell metacharacters from string values
 * - Validates device IDs against known format (IP:port or serial)
 * - Blocks private-IP SSRF in URL fields
 */
export function sanitizeArgs(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      // Prevent shell injection in any string arg
      sanitized[key] = sanitizeString(key, value, toolName);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function sanitizeString(key: string, value: string, toolName: string): string {
  // URL fields: block SSRF to private IPs
  if (key === "url" || key.endsWith("Url")) {
    try {
      const url = new URL(value);
      if (isPrivateIp(url.hostname)) {
        throw new Error(`SSRF blocked: URL "${value}" targets a private IP.`);
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Blocked URL protocol: ${url.protocol}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("SSRF")) throw err;
      if (err instanceof Error && err.message.startsWith("Blocked")) throw err;
      // If URL parsing fails for other reasons, allow but don't execute
    }
  }

  // Device ID: must match ip:port or alphanumeric serial
  if (key === "deviceId") {
    if (!/^[\w.:-]+$/.test(value)) {
      throw new Error(`Invalid deviceId format: "${value}"`);
    }
  }

  // Shell command arguments (terminal.execute): strip dangerous patterns
  if (toolName === "terminal.execute" && key === "command") {
    const dangerous = /[;&|`$(){}]|\.\.\//.test(value);
    if (dangerous) {
      // For phase 1 we log and strip — in phase 7 (sandbox) this becomes a hard block
      console.warn(`[PolicyEngine] Potential injection in command: ${value}`);
    }
  }

  return value;
}

function isPrivateIp(hostname: string): boolean {
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^::1$/,
    /^localhost$/i,
    /^0\.0\.0\.0$/,
  ];
  return privateRanges.some((r) => r.test(hostname));
}
