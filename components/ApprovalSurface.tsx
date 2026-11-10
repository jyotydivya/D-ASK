"use client";

// Phase 7B.1a: the approval panel. It shows the exact canonical action the daemon will authorize, offers one decision
// while the approval is pending, armed and unexpired, and then shows the daemon's verdict. In Ambient mode the native
// host lets this panel, and nothing else, take mouse clicks (never keyboard input or focus), so approving does not
// require switching the whole HUD to Interactive. The daemon decides every outcome.

import { useEffect, useRef, useState } from "react";
import { isNativeHud, postToHud } from "../hooks/nativeAgent";
import {
  canDecide, decisionMessage, describe, isTerminal, reduce,
  type ApprovalEvent, type ApprovalUiState,
} from "../hooks/approvalLifecycle";

const post = (m: unknown) => { if (isNativeHud()) postToHud(m); };

export default function ApprovalSurface() {
  const [state, setState] = useState<ApprovalUiState | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ApprovalUiState | null>(null);

  const dispatch = (e: ApprovalEvent) => setState((s) => { const n = reduce(s, e); stateRef.current = n; return n; });

  // Daemon messages relayed by the native host.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const m = ev.data as { type?: string; payload?: any } | null;
      if (!m?.type) return;
      const t = Date.now();
      if (m.type === "ActionApprovalRequest") dispatch({ kind: "request", payload: m.payload, nowMs: t });
      else if (m.type === "ApprovalStateNotification") dispatch({ kind: "state", payload: m.payload, nowMs: t });
      else if (m.type === "EmergencyStopTriggered" || m.type === "EmergencyStopResponse") dispatch({ kind: "stop", nowMs: t });
      else if (m.type === "AgentConnection" && m.payload?.connected === false) dispatch({ kind: "disconnected", nowMs: t });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Countdown, local expiry display and auto-dismissal of terminal states.
  useEffect(() => {
    const id = window.setInterval(() => { const t = Date.now(); setNow(t); dispatch({ kind: "tick", nowMs: t }); }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Tell the host where the panel is while a decision can be made, and that it is gone otherwise.
  const decidable = canDecide(state, now);
  const approvalId = state?.approvalId ?? "";
  useEffect(() => {
    if (!approvalId) return;
    const report = () => {
      const el = panelRef.current;
      const live = stateRef.current;
      if (!el || !live || live.phase !== "pending" || !live.view) {
        post({ type: "ApprovalSurface", payload: { approval_id: approvalId, rect: null } });
        return;
      }
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
      const w = Math.min(window.innerWidth, Math.ceil(r.right)) - x, h = Math.min(window.innerHeight, Math.ceil(r.bottom)) - y;
      post({ type: "ApprovalSurface", payload: { approval_id: approvalId, rect: w >= 1 && h >= 1 ? [x, y, w, h] : null } });
    };
    report();
    const id = window.setInterval(report, 500);
    return () => { window.clearInterval(id); post({ type: "ApprovalSurface", payload: { approval_id: approvalId, rect: null } }); };
  }, [approvalId, state?.phase]);

  if (!state) return null;

  const decide = (approved: boolean) => {
    const s = stateRef.current;
    if (!s || !canDecide(s, Date.now())) return;
    post(decisionMessage(s, approved));
    dispatch({ kind: "decide", approved, nowMs: Date.now() });
  };

  const v = state.view;
  const secondsLeft = v ? Math.max(0, Math.ceil((v.expiresAtMs - now) / 1000)) : 0;
  const arming = state.phase === "pending" && v && now < state.receivedAtMs + 1000;
  const terminal = isTerminal(state.phase);
  const riskColor = v?.risk === "Critical" ? "#ff2244" : "#ffaa30";
  const label = (t: string) => <strong style={{ color: "#94a3b8", display: "inline-block", minWidth: 118 }}>{t}</strong>;

  return (
    <div
      ref={panelRef}
      data-hud-interactive
      data-hud-approval
      role="dialog"
      aria-label="Action approval"
      // Layout: header (state, expiry) and footer (status, decision buttons) are pinned; only the details between them
      // scroll. However long the request, Approve and Deny stay inside the panel and the panel inside the viewport.
      style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: 440, maxHeight: "min(560px, calc(100vh - 32px))", boxSizing: "border-box",
        display: "flex", flexDirection: "column", overflow: "hidden",
        background: "rgba(10, 15, 25, 0.96)", border: `1px solid ${terminal ? "#475569" : "#ffaa30"}`,
        boxShadow: "0 0 30px rgba(255, 170, 48, 0.35)", borderRadius: 8, padding: 18, zIndex: 10000,
        color: "#e2e8f0", fontFamily: "monospace", fontSize: 12, lineHeight: 1.55,
      }}
    >
      <div style={{ flex: "0 0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,170,48,0.3)", paddingBottom: 8, marginBottom: 10 }}>
        <span style={{ color: "#ffaa30", fontWeight: "bold", fontSize: 13, letterSpacing: 1 }}>
          {terminal ? "APPROVAL " + state.phase.toUpperCase() : "APPROVAL REQUIRED: ONE ACTION"}
        </span>
        {v && !terminal && <span style={{ background: "rgba(255,170,48,0.2)", color: "#ffaa30", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>expires in {secondsLeft}s</span>}
      </div>

      {/* The details scroll on their own (mouse wheel or scrollbar); nothing in them is shortened or omitted. */}
      <div data-approval-details style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
      {v ? (
        <div>
          {v.inputSummary && (
            <div data-input-summary style={{ border: "1px solid #ffaa30", background: "rgba(255,170,48,0.10)", padding: 6, marginBottom: 8, color: "#fde68a" }}>
              <strong style={{ color: "#ffaa30" }}>WHAT WILL HAPPEN: </strong>{v.inputSummary}
              <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>Any mouse or keyboard use by you stops it. Emergency Stop stays available.</div>
            </div>
          )}
          <div>{label("Action")}{v.actionLabel}</div>
          <div>{label("Application")}{v.processName || "(none)"}</div>
          <div>{label("Window")}{v.windowTitle || "(none)"}</div>
          <div>{label("Process")}PID {v.processId}{v.hwnd ? ` · window 0x${v.hwnd.toString(16)}` : ""}{v.processStarted ? ` · started ${v.processStarted}` : ""}</div>
          <div>{label("Requested")}{v.reason || "(no description)"}</div>
          <div>{label("Risk")}<span style={{ color: riskColor, fontWeight: 700 }}>{v.risk}</span></div>
          <div style={{ marginTop: 8 }}>{label("Exact parameters")}{v.parameters.length === 0 ? "(none)" : ""}</div>
          {v.parameters.map((p) => (
            <div key={p.name} style={{ margin: "2px 0 2px 12px" }}>
              <span style={{ color: "#94a3b8" }}>{p.name}:</span>{" "}
              <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "rgba(148,163,184,0.12)", padding: "0 3px" }}>{p.value === "" ? "(empty)" : p.value}</span>
            </div>
          ))}
          {v.textToEnter !== null && (
            <div style={{ marginTop: 8 }}>
              {label("Text to enter")}
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", border: "1px solid #334155", padding: 6, marginTop: 4 }}>{v.textToEnter}</div>
              <div style={{ color: "#64748b", fontSize: 10 }}>{v.textToEnter.length} characters, shown in full</div>
            </div>
          )}
          {v.simulated && <div style={{ marginTop: 8, color: "#38bdf8" }}>Simulated action: D-ASK performs no real keyboard or mouse input.</div>}
          {v.approvalOnly && <div style={{ marginTop: 8, color: "#38bdf8" }}>Approval only: D-ASK cannot act on windows in this version. Approving records your consent to this one action; nothing on screen changes.</div>}
          <div style={{ marginTop: 8, fontSize: 10, color: "#64748b", wordBreak: "break-all" }}>Action digest: {v.actionDigest}</div>
        </div>
      ) : (
        <div style={{ color: "#fca5a5" }}>{state.message} No decision can be made here; the request will expire.</div>
      )}
      </div>

      {/* Pinned outside the scrolling region, on an opaque background: the status and the decision are always visible. */}
      <div data-approval-actions style={{ flex: "0 0 auto", background: "rgb(10, 15, 25)", borderTop: "1px solid rgba(255,170,48,0.3)", marginTop: 10, paddingTop: 2 }}>
      <div style={{ marginTop: 8, minHeight: 18, color: terminal ? (state.phase === "Approved" ? "#00ff88" : "#fca5a5") : "#94a3b8" }}>
        {state.phase === "submitting" && "Decision sent. Waiting for the daemon to confirm…"}
        {terminal && `The approval was ${describe(state.phase)}.${state.message ? " " + state.message : ""}`}
        {arming && "Arming… (a click already in progress is ignored)"}
        {state.phase === "pending" && v && !arming && "Click Approve or Deny. Keyboard input is not accepted here."}
      </div>

      {!terminal && v && (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <button
            type="button"
            disabled={!decidable}
            onClick={() => decide(false)}
            style={{ background: "rgba(255,34,68,0.2)", border: "1px solid #ff2244", color: "#ff4466", padding: "6px 16px", borderRadius: 4, cursor: decidable ? "pointer" : "not-allowed", fontWeight: 600, opacity: decidable ? 1 : 0.45 }}
          >DENY</button>
          <button
            type="button"
            disabled={!decidable}
            onClick={() => decide(true)}
            style={{ background: "rgba(0,255,136,0.25)", border: "1px solid #00ff88", color: "#00ff88", padding: "6px 20px", borderRadius: 4, cursor: decidable ? "pointer" : "not-allowed", fontWeight: 700, opacity: decidable ? 1 : 0.45 }}
          >APPROVE</button>
        </div>
      )}
      </div>
    </div>
  );
}
