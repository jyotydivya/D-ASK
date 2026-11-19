"use client";

import React, { useEffect, useRef, useState } from "react";
import type { DeviceInfo, HardwareDiagnostics } from "@/app/api/devices/route";

interface DevicePanelProps {
  device: DeviceInfo | null;
  hasPhysicalDevice?: boolean;
  onControlDevice: (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string; pairPort?: string; pairCode?: string; pinCode?: string; targetDeviceId?: string; broadcastAll?: boolean; newDeviceName?: string; newDeviceOs?: "Android" | "iOS" }) => void;
  onRefreshDevices?: () => void;
  isExecuting?: boolean;
}

type DevicePayload = { targetApp?: string; searchQuery?: string; deviceIp?: string; pairPort?: string; pairCode?: string; newDeviceName?: string; newDeviceOs?: "Android" | "iOS" };

/** One plain sentence for what a button will do, or null for an action this panel does not run. */
function describeDeviceAction(action: string, payload: DevicePayload | undefined, phone: string): string | null {
  switch (action) {
    case "lock": return `Turn the screen of ${phone} off (lock it), once.`;
    case "unlock": return `Wake the screen of ${phone}, once. No PIN or pattern is entered.`;
    case "go_home":
    case "home": return `Press the Home button on ${phone}, once.`;
    case "volume_up": return `Press Volume Up on ${phone}, once.`;
    case "volume_down": return `Press Volume Down on ${phone}, once.`;
    case "launch_app":
    case "launch": return `Open ${(payload?.targetApp ?? "an app").toUpperCase()} on ${phone}, once.`;
    case "take_screenshot":
    case "screenshot": return `Take a screenshot of ${phone}. It is saved in the phone's Gallery (Pictures/Screenshots) and shown in this panel.`;
    case "enable_tcpip": return `Switch ${phone} to Wi-Fi debugging on port 5555 (adb tcpip 5555), once.`;
    case "pair_connect": return "Pair this PC with the phone that is showing its pairing dialog, using the 6-digit code you typed, then connect to it over Wi-Fi (adb pair, then adb connect), once.";
    // pair_discover only looks for phones (read-only) and goes straight through the setup modal.
    // pair_bluetooth is no longer dispatched from this panel.
    default: return null;
  }
}

export default function DevicePanel({
  device,
  hasPhysicalDevice = false,
  onControlDevice,
  onRefreshDevices,
  isExecuting = false,
}: DevicePanelProps) {
  const [devicesList, setDevicesList] = useState<DeviceInfo[]>([]);
  const [diagnostics, setDiagnostics] = useState<HardwareDiagnostics | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [broadcastAll, setBroadcastAll] = useState(true);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  // 6-digit pairing code — cleared from state as soon as the request is sent; never logged.
  const [pairCodeInput, setPairCodeInput] = useState("");
  // Live status text shown in the setup modal during discover / pair / connect.
  const [setupStatus, setSetupStatus] = useState<{ text: string; kind: "idle" | "busy" | "ok" | "err" }>({ text: "", kind: "idle" });
  const [newDevName, setNewDevName] = useState("iPhone 15 Pro");
  const [newDevOs, setNewDevOs] = useState<"Android" | "iOS">("iOS");
  const [savedPin, setSavedPin] = useState("");
  // Every panel button first asks here; the action runs only after APPROVE. (A confirmation shown by this panel: the daemon does not
  // enforce it, unlike the approval cards for requests typed into the console.)
  const [pending, setPending] = useState<{ action: string; payload?: DevicePayload; run?: () => void } | null>(null);
  const [showShot, setShowShot] = useState(false);
  // Ref to the code input so we can focus it when the modal opens.
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Poll list of all devices & diagnostics
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const res = await fetch("/api/devices");
        const data = (await res.json()) as { devices?: DeviceInfo[]; activeDevice?: DeviceInfo; diagnostics?: HardwareDiagnostics };
        if (data.diagnostics) {
          setDiagnostics(data.diagnostics);
        }
        if (data.devices && data.devices.length > 0) {
          setDevicesList(data.devices);
          if (!selectedDeviceId && data.activeDevice) {
            setSelectedDeviceId(data.activeDevice.id);
          }
        }
      } catch {
        // Ignored
      }
    };
    void fetchAll();
    const interval = setInterval(fetchAll, 2500);
    return () => clearInterval(interval);
  }, [selectedDeviceId]);

  useEffect(() => {
    const pin = window.localStorage.getItem("ultron-device-pin");
    if (pin) setSavedPin(pin);
  }, []);

  // Focus the code input each time the setup modal opens.
  useEffect(() => {
    if (showSetupGuide) {
      setSetupStatus({ text: "", kind: "idle" });
      setTimeout(() => codeInputRef.current?.focus(), 80);
    }
  }, [showSetupGuide]);

  const updatePin = (pin: string) => {
    setSavedPin(pin);
    window.localStorage.setItem("ultron-device-pin", pin);
  };

  const connectedDevs = devicesList.filter((d) => d.status === "CONNECTED");
  const activeDev = connectedDevs.find((d) => d.id === selectedDeviceId) || connectedDevs[0] || null;

  const runAction = (action: string, payload?: DevicePayload) => {
    onControlDevice(action, {
      ...payload,
      targetDeviceId: broadcastAll ? undefined : selectedDeviceId,
      broadcastAll,
      pinCode: savedPin,
    });
  };

  // A button press asks first; an action this panel does not know goes straight through and is answered with an error.
  const dispatchAction = (action: string, payload?: DevicePayload) => {
    if (describeDeviceAction(action, payload, "x") === null) { runAction(action, payload); return; }
    setPending({ action, payload });
  };

  // ── Wireless pairing flow ─────────────────────────────────────────────────────────────────────────────────────────

  /** POST /api/devices with an action; returns the parsed JSON body. */
  const postDevice = async (
    action: string,
    extra: Record<string, string> = {}
  ): Promise<{
    success: boolean;
    error?: string;
    result?: string;
    pairingEndpoints?: string[];
    connectEndpoints?: string[];
    connectedTo?: string;
  }> => {
    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      return (await res.json()) as {
        success: boolean;
        error?: string;
        result?: string;
        pairingEndpoints?: string[];
        connectEndpoints?: string[];
        connectedTo?: string;
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  };

  /** "FIND PHONE" button: runs pair_discover and updates status text. No phone pairing happens here. */
  const handleFindPhone = async () => {
    setSetupStatus({ text: "🔍 Scanning for phones with an open pairing dialog…", kind: "busy" });
    const data = await postDevice("pair_discover");
    if (!data.success) {
      setSetupStatus({ text: `❌ Scan failed: ${data.error ?? "unknown error"}`, kind: "err" });
      return;
    }
    const pairCount = data.pairingEndpoints?.length ?? 0;
    const connCount = data.connectEndpoints?.length ?? 0;
    if (pairCount === 0 && connCount === 0) {
      setSetupStatus({ text: "⚠️ No phone found. Make sure the phone's 'Pair device with pairing code' dialog is open.", kind: "err" });
    } else if (pairCount > 0) {
      const eps = data.pairingEndpoints!.join(", ");
      setSetupStatus({ text: `✅ Found pairing dialog on: ${eps}. Enter the 6-digit code and press PAIR AND CONNECT.`, kind: "ok" });
    } else {
      setSetupStatus({ text: `✅ Phone already reachable at: ${data.connectEndpoints!.join(", ")}. You can close this dialog.`, kind: "ok" });
    }
  };

  /** "PAIR AND CONNECT" button: validates code locally, posts pair_connect. Code is cleared from state immediately after. */
  const handlePairAndConnect = () => {
    const code = pairCodeInput.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setSetupStatus({ text: "❌ The code must be exactly 6 digits (0–9). Check the phone screen.", kind: "err" });
      return;
    }
    // Clear the code from state at once — it must not persist in the component; the closure below holds it only until APPROVE/DENY.
    setPairCodeInput("");
    setSetupStatus({ text: "Waiting for your approval…", kind: "busy" });
    setPending({ action: "pair_connect", run: () => { void sendPair(code); } });
  };

  const sendPair = async (sentCode: string) => {
    setSetupStatus({ text: "🔗 Pairing… (this takes up to 25 seconds, keep the phone dialog open)", kind: "busy" });
    const data = await postDevice("pair_connect", { pairCode: sentCode });
    // sentCode goes out of scope here; it was never logged or written to disk by this component.
    if (data.success) {
      setSetupStatus({ text: `✅ ${data.result ?? `Connected to ${data.connectedTo ?? "the phone"}`}`, kind: "ok" });
      if (onRefreshDevices) onRefreshDevices();
      // Auto-close the modal after a short delay so the user can read the confirmation.
      setTimeout(() => setShowSetupGuide(false), 2200);
    } else {
      setSetupStatus({ text: `❌ ${data.error ?? "Pairing failed for an unknown reason."}`, kind: "err" });
    }
  };

  const approvalCard = pending ? (
    <div className="device-approval-backdrop" data-hud-interactive>
      <div className="device-approval-card" role="alertdialog" aria-label="Approval required">
        <div className="device-approval-title">APPROVAL REQUIRED: ONE ACTION</div>
        <div className="device-approval-text">{describeDeviceAction(pending.action, pending.payload, activeDev?.name ?? "the phone")}</div>
        <div className="device-approval-note">Nothing runs until you press APPROVE. DENY cancels.</div>
        <div className="device-approval-buttons">
          <button type="button" className="dev-btn device-approve" onClick={() => { const p = pending; setPending(null); if (p.run) p.run(); else runAction(p.action, p.payload); }}>APPROVE</button>
          <button type="button" className="dev-btn device-deny" onClick={() => { if (pending.run) setSetupStatus({ text: "Pairing cancelled. Type the code again to retry.", kind: "idle" }); setPending(null); }}>DENY</button>
        </div>
      </div>
    </div>
  ) : null;

  const shotOverlay = showShot && activeDev?.screenshotUrl ? (
    <div className="device-shot-backdrop" data-hud-interactive onClick={() => setShowShot(false)}>
      <img className="device-shot-full" src={activeDev.screenshotUrl} alt="Phone screenshot, full size" />
      <div className="device-shot-hint">CLICK ANYWHERE TO CLOSE</div>
    </div>
  ) : null;

  // ── Status badge style inside the setup modal ────────────────────────────────────────────────────────────────────
  const statusColor: Record<string, string> = { idle: "transparent", busy: "rgba(255,170,0,0.15)", ok: "rgba(0,255,150,0.15)", err: "rgba(255,60,60,0.15)" };
  const statusBorder: Record<string, string> = { idle: "transparent", busy: "#ffaa00", ok: "#00ffaa", err: "#ff5533" };

  // ── The pairing setup modal (shared between "no phone" state and the connected state's bottom bar) ───────────────
  const setupModal = showSetupGuide ? (
    <div className="modal-backdrop" data-hud-interactive onClick={() => setShowSetupGuide(false)}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>CONNECT PHONE VIA WIRELESS DEBUGGING</span>
          <button type="button" className="modal-close" onClick={() => setShowSetupGuide(false)}>✕</button>
        </div>
        <div className="modal-body">

          {/* 3-step instructions */}
          <div className="guide-steps" style={{ fontSize: "10px", lineHeight: "1.5" }}>
            <div className="step">
              <span className="step-num">1</span>
              <span>On your phone: <strong>Settings → Developer Options → Wireless Debugging</strong><br />
                Tap <strong>&quot;Pair device with pairing code&quot;</strong> and <strong>keep that dialog open</strong>.</span>
            </div>
            <div className="step">
              <span className="step-num">2</span>
              <span>Press <strong>FIND PHONE</strong> below (this PC and the phone must be on the same Wi-Fi).</span>
            </div>
            <div className="step">
              <span className="step-num">3</span>
              <span>Type the <strong>6-digit code</strong> shown on the phone&apos;s pairing dialog, then press <strong>PAIR AND CONNECT</strong>.</span>
            </div>
          </div>

          {/* Status banner */}
          {setupStatus.kind !== "idle" && (
            <div style={{
              marginTop: "10px",
              background: statusColor[setupStatus.kind],
              border: `1px solid ${statusBorder[setupStatus.kind]}`,
              borderRadius: "4px",
              padding: "7px 10px",
              fontSize: "9px",
              lineHeight: "1.4",
              color: setupStatus.kind === "err" ? "#ff9988" : setupStatus.kind === "ok" ? "#88ffcc" : "#ffcc66",
            }}>
              {setupStatus.text}
            </div>
          )}

          {/* Code input + action buttons */}
          <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <label style={{ fontSize: "9px", opacity: 0.8, display: "block", marginBottom: "4px", color: "#88ffcc" }}>
                6-DIGIT PAIRING CODE (from the phone screen):
              </label>
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pairCodeInput}
                onChange={(e) => setPairCodeInput(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 492817"
                className="command-input"
                style={{
                  width: "100%",
                  border: "1px solid var(--hud-border)",
                  borderRadius: "3px",
                  padding: "8px 12px",
                  fontSize: "20px",
                  fontFamily: "monospace",
                  letterSpacing: "0.3em",
                  textAlign: "center",
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void handlePairAndConnect(); }}
              />
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="dev-btn"
                style={{ flex: 1, padding: "8px", fontWeight: "bold", fontSize: "9px" }}
                disabled={setupStatus.kind === "busy"}
                onClick={() => void handleFindPhone()}
              >
                🔍 FIND PHONE
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                style={{ flex: 2, padding: "8px", fontWeight: "bold", background: "var(--hud-color)", color: "#000" }}
                disabled={setupStatus.kind === "busy" || pairCodeInput.length !== 6}
                onClick={() => void handlePairAndConnect()}
              >
                ⚡ PAIR AND CONNECT
              </button>
            </div>
          </div>

          {/* Alternative: USB tcpip */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "10px", marginTop: "12px" }}>
            <div style={{ fontSize: "9px", opacity: 0.7, marginBottom: "4px" }}>
              ALTERNATIVE: Plug phone in via USB once and click below to permanently enable Wireless ADB on port 5555:
            </div>
            <button
              type="button"
              className="dev-btn"
              style={{ width: "100%", padding: "6px", fontSize: "9px" }}
              onClick={() => { dispatchAction("enable_tcpip"); }}
            >
              🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
            </button>
          </div>

          <div className="modal-actions" style={{ marginTop: "12px" }}>
            <button
              type="button"
              className="dev-btn"
              onClick={() => {
                if (onRefreshDevices) onRefreshDevices();
                setShowSetupGuide(false);
              }}
            >
              RE-SCAN ADB DEVICES
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  if (!activeDev) {
    return (
      <>
        {approvalCard}{shotOverlay}<aside className="device-hud-panel" aria-label="Connected Devices HUD Panel" data-hud-interactive>
          <div className="device-header">
            <div className="device-title-wrap">
              <span className="device-indicator" data-physical={false} />
              <span className="device-title">HARDWARE MATRIX</span>
            </div>
            <span className="device-status-badge status-offline">OFFLINE (0)</span>
          </div>

          <div style={{ padding: "16px 8px", textAlign: "center", display: "flex", flexDirection: "column", gap: "12px", alignItems: "center" }}>
            <div style={{ fontSize: "24px" }}>📱</div>
            <div style={{ fontSize: "11px", fontWeight: "bold", color: "#ffaa44", letterSpacing: "0.05em" }}>
              NO PHYSICAL PHONE CONNECTED
            </div>
            <p style={{ fontSize: "9px", opacity: 0.7, margin: 0, lineHeight: "1.4" }}>
              Connect your phone via Wireless Debugging (Wi-Fi) or USB cable to control it.
            </p>

            {diagnostics?.troubleshootStep && (
              <div style={{
                background: "rgba(255, 170, 0, 0.15)",
                border: "1px solid #ffaa00",
                color: "#ffcc66",
                fontSize: "8px",
                padding: "6px 8px",
                borderRadius: "4px",
                lineHeight: "1.3",
                textAlign: "left",
                width: "100%",
              }}>
                ℹ️ <strong>DIAGNOSTIC:</strong> {diagnostics.troubleshootStep}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", marginTop: "4px" }}>
              <button
                type="button"
                className="modal-btn-primary"
                style={{ width: "100%", padding: "8px", fontWeight: "bold", cursor: "pointer" }}
                onClick={() => {
                  if (onRefreshDevices) onRefreshDevices();
                  setShowSetupGuide(true);
                }}
              >
                ⚡ CONNECT PHONE (WIRELESS ADB)
              </button>

              <button
                type="button"
                className="dev-btn"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: "9px",
                  fontWeight: "bold",
                  background: "rgba(0, 255, 170, 0.12)",
                  border: "1px solid #00ffaa",
                  color: "#00ffaa",
                  cursor: "pointer",
                }}
                onClick={() => { dispatchAction("enable_tcpip"); }}
              >
                🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
              </button>
            </div>
          </div>
        </aside>

        {setupModal}
      </>
    );
  }

  const isLocked = activeDev.isLocked;
  const currentAppUpper = (activeDev.currentApp || "SYSTEM LAUNCHER").toUpperCase();
  const isPhysical = activeDev.isPhysical;
  const isIos = activeDev.os === "iOS";

  return (
    <>
      {approvalCard}{shotOverlay}<aside className="device-hud-panel" aria-label="Connected Devices HUD Panel" data-hud-interactive>
        {/* HUD Top Bar & Multi-Device Selector */}
        <div className="device-header">
          <div className="device-title-wrap">
            <span className="device-indicator" data-physical={isPhysical} />
            <span className="device-title">
              MULTI-DEVICE MATRIX ({devicesList.length})
            </span>
          </div>
          <button
            type="button"
            className={`device-status-badge ${broadcastAll ? "status-physical" : "status-online"}`}
            onClick={() => setBroadcastAll(!broadcastAll)}
            title="Click to toggle between Broadcast to All Devices and Single Device mode"
            style={{
              cursor: "pointer",
              background: broadcastAll ? "#00ffaa" : "rgba(255,255,255,0.1)",
              color: broadcastAll ? "#000" : "#fff",
              fontWeight: "bold",
              padding: "2px 8px",
              borderRadius: "4px",
              border: broadcastAll ? "1px solid #00ffaa" : "1px solid rgba(255,255,255,0.2)",
            }}
          >
            {broadcastAll ? `⚡ BROADCAST ALL (${connectedDevs.length})` : "SINGLE DEVICE"}
          </button>
        </div>

        {/* Multi-Device Tabs Switcher Bar */}
        <div className="multi-device-tabs" style={{ display: "flex", gap: "4px", marginBottom: "8px", overflowX: "auto" }}>
          {devicesList.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`dev-tab ${selectedDeviceId === d.id ? "active-tab" : ""}`}
              onClick={() => setSelectedDeviceId(d.id)}
              style={{
                fontSize: "8px",
                padding: "3px 6px",
                border: "1px solid var(--hud-border)",
                background: selectedDeviceId === d.id ? "var(--hud-color)" : "rgba(0,0,0,0.5)",
                color: selectedDeviceId === d.id ? "#000" : "var(--hud-text-bright)",
                borderRadius: "3px",
                fontWeight: "bold",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {d.os === "iOS" ? "🍎" : "📱"} {d.name.split(" ")[0]}
            </button>
          ))}
          <button
            type="button"
            className="dev-tab add-tab"
            onClick={() => setShowAddModal(true)}
            style={{
              fontSize: "9px",
              padding: "3px 6px",
              border: "1px dashed var(--hud-border)",
              background: "rgba(255,255,255,0.08)",
              color: "var(--hud-text-bright)",
              borderRadius: "3px",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            + ADD
          </button>
        </div>

        {/* Diagnostic Banner Status Notice */}
        {diagnostics?.troubleshootStep && (
          <div style={{
            background: "rgba(255, 85, 51, 0.2)",
            border: "1px solid #ff5533",
            color: "#ffcc66",
            fontSize: "8px",
            padding: "4px 6px",
            borderRadius: "3px",
            marginBottom: "6px",
            lineHeight: "1.3",
          }}>
            ⚠️ <strong>DIAGNOSTIC:</strong> {diagnostics.troubleshootStep}
          </div>
        )}

        {/* Main Active Device Telemetry Card */}
        <div className="device-card">
          <div className="device-info-main">
            <div className="device-name">{isIos ? "🍎 " : "📱 "}{activeDev.name}</div>
            <div className="device-sub">{activeDev.model} · {activeDev.osVersion}</div>
          </div>

          <div className="device-stats-grid">
            <div className="device-stat">
              <span className="stat-label">BATTERY</span>
              <span className="stat-val">{activeDev.batteryLevel}% {activeDev.isCharging ? "⚡" : ""}</span>
            </div>
            <div className="device-stat">
              <span className="stat-label">SIGNAL</span>
              <span className="stat-val">{activeDev.signalStrength}% 📶</span>
            </div>
            <div className="device-stat">
              <span className="stat-label">OS MATRIX</span>
              <span className="stat-val" style={{ color: isIos ? "#88f2ff" : "#88ffcc" }}>
                {activeDev.os.toUpperCase()}
              </span>
            </div>
            <div className="device-stat">
              <span className="stat-label">CURRENT APP</span>
              <span className="stat-val app-name">{currentAppUpper}</span>
            </div>
          </div>
        </div>

        {/* Live Device Screen Display / Real Screenshot Preview */}
        <div className={`device-screen-preview${activeDev.screenshotUrl ? " has-shot" : ""}`}>
          <div className="screen-frame">
            <div className="screen-notch" />
            <div className="screen-content" data-app={currentAppUpper}>
              {activeDev.screenshotUrl ? (
                <img
                  src={activeDev.screenshotUrl}
                  alt="Captured Device Screen (click to enlarge)"
                  title="Click to enlarge"
                  onClick={() => setShowShot(true)}
                  style={{ width: "100%", height: "100%", objectFit: "contain", cursor: "zoom-in" }}
                />
              ) : isLocked ? (
                <div className="screen-locked">
                  <span className="lock-icon">🔒</span>
                  <span className="lock-text">{activeDev.name.toUpperCase()} LOCKED</span>
                  <span className="lock-sub">SAY &quot;D-ASK UNLOCK PHONE&quot;</span>
                </div>
              ) : currentAppUpper.includes("YOUTUBE") ? (
                <div className="screen-app app-youtube">
                  <div className="yt-header">▶ YouTube // {currentAppUpper}</div>
                  <div className="yt-video-mock">
                    <div className="play-btn">▶</div>
                  </div>
                  <div className="yt-meta">
                    {isIos ? "iOS AIRPLAY STREAMING" : "WIRELESS STREAMING ACTIVE"}
                  </div>
                </div>
              ) : currentAppUpper.includes("INSTAGRAM") ? (
                <div className="screen-app app-insta">
                  <div className="insta-header">📷 Instagram Feed</div>
                  <div className="insta-post-mock">
                    <div className="avatar" />
                    <div className="post-lines">
                      <div className="line" />
                      <div className="line short" />
                    </div>
                  </div>
                </div>
              ) : currentAppUpper.includes("CAMERA") ? (
                <div className="screen-app app-camera">
                  <div className="camera-viewfinder">
                    <div className="reticle" />
                  </div>
                </div>
              ) : (
                <div className="screen-app app-launcher">
                  <div className="launcher-clock">12:00</div>
                  <div className="app-grid">
                    <div className="app-icon yt" title="YouTube">▶</div>
                    <div className="app-icon ig" title="Instagram">📷</div>
                    <div className="app-icon cam" title="Camera">📷</div>
                    <div className="app-icon set" title="Settings">⚙️</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Auto PIN Unlock Setting */}
        <div className="pin-setting-row" style={{ margin: "4px 0 6px 0", display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "8px", opacity: 0.7, letterSpacing: "0.08em" }}>AUTO-PIN:</span>
          <input
            type="password"
            value={savedPin}
            onChange={(e) => updatePin(e.target.value)}
            placeholder="ENTER PHONE PIN"
            maxLength={8}
            style={{
              flex: 1,
              background: "rgba(0,0,0,0.5)",
              border: "1px solid var(--hud-border)",
              borderRadius: "3px",
              color: "#fff",
              fontSize: "9px",
              padding: "2px 6px",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Device Control Action Buttons */}
        <div className="device-actions">
          <div className="action-row">
            <button
              type="button"
              className="dev-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction(isLocked ? "unlock" : "lock")}
            >
              {isLocked ? "UNLOCK" : "LOCK"} {broadcastAll ? "ALL" : ""}
            </button>
            <button
              type="button"
              className="dev-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("go_home")}
            >
              HOME SCREEN
            </button>
          </div>

          <div className="action-row">
            <button
              type="button"
              className="dev-btn app-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("launch_app", { targetApp: "youtube" })}
            >
              ▶ YOUTUBE
            </button>
            <button
              type="button"
              className="dev-btn app-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("launch_app", { targetApp: "instagram" })}
            >
              📷 INSTAGRAM
            </button>
            <button
              type="button"
              className="dev-btn app-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("launch_app", { targetApp: "camera" })}
            >
              📷 CAMERA
            </button>
          </div>

          <div className="action-row">
            <button
              type="button"
              className="dev-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("take_screenshot")}
            >
              📸 SCREENSHOT
            </button>
            <button
              type="button"
              className="dev-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("volume_up")}
            >
              VOL +
            </button>
            <button
              type="button"
              className="dev-btn"
              disabled={isExecuting}
              onClick={() => dispatchAction("volume_down")}
            >
              VOL -
            </button>
          </div>

          {/* Pair Bar & USB Enable Controls */}
          <div className="action-row setup-row" style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", marginTop: "6px" }}>
            <button
              type="button"
              className="modal-btn-primary"
              style={{ width: "100%", padding: "6px", fontWeight: "bold", cursor: "pointer", fontSize: "9px" }}
              onClick={() => {
                if (onRefreshDevices) onRefreshDevices();
                setShowSetupGuide(true);
              }}
            >
              ⚡ CONNECT PHONE (WIRELESS ADB)
            </button>

            <button
              type="button"
              className="dev-btn"
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: "9px",
                fontWeight: "bold",
                background: "rgba(0, 255, 170, 0.15)",
                border: "1px solid #00ffaa",
                color: "#00ffaa",
                cursor: "pointer",
              }}
              onClick={() => { dispatchAction("enable_tcpip"); }}
            >
              🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
            </button>
          </div>
        </div>
      </aside>

      {/* Add New Device Modal (iPhone / Android) */}
      {showAddModal && (
        <div className="modal-backdrop" data-hud-interactive onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>ADD NEW DEVICE TO MATRIX</span>
              <button type="button" className="modal-close" onClick={() => setShowAddModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p>Select Operating System and device name to register a new physical device:</p>

              <div style={{ display: "flex", gap: "10px", margin: "12px 0" }}>
                <button
                  type="button"
                  className={`modal-btn-primary ${newDevOs === "iOS" ? "active" : ""}`}
                  onClick={() => setNewDevOs("iOS")}
                  style={{ flex: 1, background: newDevOs === "iOS" ? "var(--hud-color)" : "rgba(255,255,255,0.1)", color: newDevOs === "iOS" ? "#000" : "#fff" }}
                >
                  🍎 IPHONE / IPAD (iOS)
                </button>
                <button
                  type="button"
                  className={`modal-btn-primary ${newDevOs === "Android" ? "active" : ""}`}
                  onClick={() => setNewDevOs("Android")}
                  style={{ flex: 1, background: newDevOs === "Android" ? "var(--hud-color)" : "rgba(255,255,255,0.1)", color: newDevOs === "Android" ? "#000" : "#fff" }}
                >
                  📱 ANDROID SMARTPHONE
                </button>
              </div>

              <div style={{ margin: "10px 0" }}>
                <label style={{ fontSize: "9px", display: "block", marginBottom: "4px" }}>DEVICE NAME:</label>
                <input
                  type="text"
                  value={newDevName}
                  onChange={(e) => setNewDevName(e.target.value)}
                  placeholder="e.g. iPhone 15 Pro"
                  className="command-input"
                  style={{ width: "100%", border: "1px solid var(--hud-border)", borderRadius: "3px", padding: "6px" }}
                />
              </div>

              <div className="modal-actions" style={{ marginTop: "16px" }}>
                <button
                  type="button"
                  className="modal-btn-primary"
                  onClick={() => {
                    dispatchAction("add_device", { newDeviceName: newDevName, newDeviceOs: newDevOs });
                    setShowAddModal(false);
                  }}
                >
                  REGISTER DEVICE TO MATRIX
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Wireless Setup Guide Modal */}
      {setupModal}
    </>
  );
}
