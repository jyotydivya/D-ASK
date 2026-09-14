// ─────────────────────────────────────────────────────────────────────────────
// AgentStatusPanel — Live agentic activity HUD panel
// Overlays the existing D-ASK holographic interface
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import React, { useEffect, useRef } from "react";
import type { TaskEvent, TaskNode, OrbState } from "../agent/types";

interface AgentStatusPanelProps {
  isActive: boolean;
  orbState: OrbState;
  lastMessage: string;
  events: TaskEvent[];
  nodes: TaskNode[];
  progressPct: number;
  taskId: string | null;
  onCancel?: () => void;
}

const STATE_COLORS: Record<OrbState, string> = {
  standby:      "#00d4ff",
  listening:    "#39ff14",
  understanding: "#a78bfa",
  planning:     "#f59e0b",
  executing:    "#00d4ff",
  tool_use:     "#fb923c",
  waiting:      "#fbbf24",
  verifying:    "#34d399",
  replanning:   "#f59e0b",
  completed:    "#39ff14",
  error:        "#ff4444",
};

const STATE_LABELS: Record<OrbState, string> = {
  standby:      "STANDBY",
  listening:    "LISTENING",
  understanding: "UNDERSTANDING",
  planning:     "PLANNING",
  executing:    "EXECUTING",
  tool_use:     "TOOL CALL",
  waiting:      "AWAITING APPROVAL",
  verifying:    "VERIFYING",
  replanning:   "REPLANNING",
  completed:    "COMPLETED",
  error:        "ERROR",
};

function getEventIcon(type: string): string {
  if (type.includes("task.created")) return "◎";
  if (type.includes("task.planned")) return "⬡";
  if (type.includes("task.completed")) return "✓";
  if (type.includes("task.failed")) return "✗";
  if (type.includes("agent.started")) return "▶";
  if (type.includes("agent.completed")) return "●";
  if (type.includes("agent.failed")) return "✗";
  if (type.includes("tool.started")) return "⚙";
  if (type.includes("tool.completed")) return "⚙";
  if (type.includes("tool.failed")) return "⚠";
  if (type.includes("approval")) return "⚠";
  if (type.includes("node.completed")) return "◆";
  if (type.includes("verification")) return "⬢";
  return "·";
}

function getEventColor(type: string): string {
  if (type.includes("completed")) return "#39ff14";
  if (type.includes("failed")) return "#ff4444";
  if (type.includes("approval")) return "#fbbf24";
  if (type.includes("tool")) return "#fb923c";
  if (type.includes("agent")) return "#00d4ff";
  if (type.includes("verification")) return "#34d399";
  return "#a8b4c0";
}

function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AgentStatusPanel({
  isActive,
  orbState,
  lastMessage,
  events,
  nodes,
  progressPct,
  taskId,
  onCancel,
}: AgentStatusPanelProps) {
  const eventsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (!isActive && events.length === 0) return null;

  const color = STATE_COLORS[orbState];
  const label = STATE_LABELS[orbState];
  const recentEvents = events.slice(-20);

  // Compute DAG progress
  const totalNodes = nodes.length;
  const completedNodes = nodes.filter((n) => n.status === "completed" || n.status === "skipped").length;
  const runningNodes = nodes.filter((n) => n.status === "running");
  const displayProgress = totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : progressPct;

  return (
    <div
      style={{
        position: "fixed",
        right: "20px",
        top: "50%",
        transform: "translateY(-50%)",
        width: "340px",
        maxHeight: "70vh",
        background: "rgba(0, 8, 20, 0.92)",
        border: `1px solid ${color}40`,
        borderRadius: "12px",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: `0 0 30px ${color}20, 0 0 60px rgba(0,0,0,0.5)`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 1000,
        transition: "border-color 0.5s, box-shadow 0.5s",
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${color}30`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Pulsing indicator */}
          <div
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 8px ${color}`,
              animation: isActive ? "pulse-dot 1.2s ease-in-out infinite" : "none",
            }}
          />
          <span
            style={{
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "2px",
              color,
              textTransform: "uppercase",
            }}
          >
            {label}
          </span>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {taskId && (
            <span style={{ fontSize: "9px", color: "#4a5568", letterSpacing: "1px" }}>
              {taskId.slice(-8).toUpperCase()}
            </span>
          )}
          {isActive && onCancel && (
            <button
              onClick={onCancel}
              style={{
                background: "transparent",
                border: `1px solid #ff444440`,
                borderRadius: "4px",
                padding: "2px 8px",
                color: "#ff4444",
                fontSize: "9px",
                cursor: "pointer",
                letterSpacing: "1px",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#ff444420";
                e.currentTarget.style.borderColor = "#ff4444";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "#ff444440";
              }}
            >
              CANCEL
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(isActive || displayProgress > 0) && (
        <div style={{ padding: "8px 16px 4px", borderBottom: `1px solid ${color}20` }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
            <span style={{ fontSize: "9px", color: "#4a5568", letterSpacing: "1px" }}>
              PROGRESS — {totalNodes > 0 ? `${completedNodes}/${totalNodes} STEPS` : ""}
            </span>
            <span style={{ fontSize: "9px", color }}>
              {displayProgress}%
            </span>
          </div>
          <div
            style={{
              height: "2px",
              background: "#1a2535",
              borderRadius: "2px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${displayProgress}%`,
                background: `linear-gradient(90deg, ${color}80, ${color})`,
                borderRadius: "2px",
                transition: "width 0.5s ease",
                boxShadow: `0 0 8px ${color}60`,
              }}
            />
          </div>
        </div>
      )}

      {/* Running agents */}
      {runningNodes.length > 0 && (
        <div style={{ padding: "6px 16px", borderBottom: `1px solid ${color}15` }}>
          {runningNodes.map((node) => (
            <div
              key={node.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "9px",
                color: "#00d4ff",
                marginBottom: "2px",
              }}
            >
              <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
              <span style={{ letterSpacing: "1px", textTransform: "uppercase" }}>
                {node.agentType} — {node.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Last message */}
      {lastMessage && (
        <div
          style={{
            padding: "8px 16px",
            fontSize: "10px",
            color: "#c0ccd8",
            letterSpacing: "0.5px",
            borderBottom: `1px solid ${color}15`,
            lineHeight: "1.5",
          }}
        >
          {lastMessage}
        </div>
      )}

      {/* DAG Node list */}
      {nodes.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: `1px solid ${color}15`,
          }}
        >
          <div style={{ fontSize: "9px", color: "#4a5568", letterSpacing: "2px", marginBottom: "6px" }}>
            TASK GRAPH
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            {nodes.map((node) => {
              const nodeColor =
                node.status === "completed" ? "#39ff14"
                : node.status === "running" ? "#00d4ff"
                : node.status === "failed" ? "#ff4444"
                : "#2d3748";
              const nodeIcon =
                node.status === "completed" ? "●"
                : node.status === "running" ? "▶"
                : node.status === "failed" ? "✗"
                : "○";
              return (
                <div
                  key={node.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "9px",
                    color: nodeColor,
                    letterSpacing: "0.5px",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{nodeIcon}</span>
                  <span style={{ textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    [{node.agentType}] {node.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Event log */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "3px",
          maxHeight: "180px",
          scrollbarWidth: "none",
        }}
      >
        <div style={{ fontSize: "9px", color: "#4a5568", letterSpacing: "2px", marginBottom: "4px", padding: "0 4px" }}>
          EVENT LOG
        </div>
        {recentEvents.map((event) => {
          const icon = getEventIcon(event.type);
          const evColor = getEventColor(event.type);
          const timestamp = formatTime(event.timestamp);
          const msg = eventToMessage(event);
          if (!msg) return null;

          return (
            <div
              key={event.id}
              style={{
                display: "flex",
                gap: "6px",
                fontSize: "9px",
                lineHeight: "1.4",
                padding: "2px 4px",
                borderRadius: "3px",
              }}
            >
              <span style={{ color: "#2d3748", flexShrink: 0 }}>{timestamp}</span>
              <span style={{ color: evColor, flexShrink: 0 }}>{icon}</span>
              <span style={{ color: "#7a8a9a", wordBreak: "break-word" }}>{msg}</span>
            </div>
          );
        })}
        <div ref={eventsEndRef} />
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// Helper — also used by useTask
export function eventToMessage(event: TaskEvent): string {
  const { type, payload } = event;
  switch (type) {
    case "task.created":     return `Task created: "${String(payload.objective ?? "").slice(0, 60)}"`;
    case "task.planned":     return `Plan ready — ${payload.nodeCount} steps`;
    case "task.started":     return "Execution started";
    case "task.completed":   return "✓ Task completed";
    case "task.failed":      return `✗ Task failed: ${String(payload.error ?? "").slice(0, 80)}`;
    case "task.cancelled":   return "Task cancelled";
    case "task.replanned":   return `Replanning (attempt ${payload.replanCount})`;
    case "agent.started":    return `[${String(payload.agent).toUpperCase()}] ${String(payload.nodeName)}...`;
    case "agent.progress":   return String(payload.message ?? "");
    case "agent.completed":  return `✓ ${String(payload.summary ?? "").slice(0, 80)}`;
    case "agent.failed":     return `✗ ${String(payload.error ?? "").slice(0, 80)}`;
    case "tool.started":     return `⚙ ${String(payload.tool)}`;
    case "tool.completed":   return `⚙ ${String(payload.tool)} → done (${payload.durationMs}ms)`;
    case "tool.failed":      return `✗ ${String(payload.tool)} — ${String(payload.error ?? "").slice(0, 60)}`;
    case "approval.required": return `⚠ Approval required for: ${String(payload.tool)}`;
    case "verification.started": return "Verifying task outcome...";
    case "verification.completed": return `Verification ${payload.passed ? "✓ passed" : "✗ failed"} (${Number(payload.score ?? 0).toFixed(2)})`;
    case "node.completed":   return `Step complete: ${String(payload.name)}`;
    case "node.failed":      return `Step failed: ${String(payload.name)}`;
    default:                 return "";
  }
}
