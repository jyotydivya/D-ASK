"use client";

import React, { useEffect, useState } from "react";
import type { DeviceInfo, HardwareDiagnostics } from "@/app/api/devices/route";

interface DevicePanelProps {
  device: DeviceInfo | null;
  hasPhysicalDevice?: boolean;
  onControlDevice: (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string; pairPort?: string; pairCode?: string; pinCode?: string; targetDeviceId?: string; broadcastAll?: boolean; newDeviceName?: string; newDeviceOs?: "Android" | "iOS" }) => void;
  onRefreshDevices?: () => void;
  isExecuting?: boolean;
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
  const [bluetoothIp, setBluetoothIp] = useState("192.168.137.37:38765");
  const [pairPortInput, setPairPortInput] = useState("");
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [newDevName, setNewDevName] = useState("iPhone 15 Pro");
  const [newDevOs, setNewDevOs] = useState<"Android" | "iOS">("iOS");
  const [savedPin, setSavedPin] = useState("");

  // Poll list of all devices & diagnostics
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const res = await fetch("/api/devices");
        const data = (await res.json()) as { devices?: DeviceInfo[]; activeDevice?: DeviceInfo; diagnostics?: HardwareDiagnostics };
        if (data.diagnostics) {
          setDiagnostics(data.diagnostics);
          if (data.diagnostics.discoveredMdnsDevice && bluetoothIp === "192.168.137.38:37517") {
            setBluetoothIp(data.diagnostics.discoveredMdnsDevice);
          }
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
  }, [selectedDeviceId, bluetoothIp]);

  useEffect(() => {
    const pin = window.localStorage.getItem("ultron-device-pin");
    if (pin) setSavedPin(pin);
  }, []);

  const updatePin = (pin: string) => {
    setSavedPin(pin);
    window.localStorage.setItem("ultron-device-pin", pin);
  };

  const connectedDevs = devicesList.filter((d) => d.status === "CONNECTED");
  const activeDev = connectedDevs.find((d) => d.id === selectedDeviceId) || connectedDevs[0] || null;

  const dispatchAction = (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string; pairPort?: string; pairCode?: string; newDeviceName?: string; newDeviceOs?: "Android" | "iOS" }) => {
    onControlDevice(action, {
      ...payload,
      targetDeviceId: broadcastAll ? undefined : selectedDeviceId,
      broadcastAll,
      pinCode: savedPin,
    });
  };

  if (!activeDev) {
    return (
      <>
        <aside className="device-hud-panel" aria-label="Connected Devices HUD Panel">
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
                onClick={() => {
                  dispatchAction("enable_tcpip");
                }}
              >
                🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
              </button>
            </div>
          </div>
        </aside>

        {showSetupGuide && (
          <div className="modal-backdrop" onClick={() => setShowSetupGuide(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span>WIRELESS PHONE CONNECTION</span>
                <button type="button" className="modal-close" onClick={() => setShowSetupGuide(false)}>✕</button>
              </div>
              <div className="modal-body">
                {diagnostics?.hotspotIps && diagnostics.hotspotIps.length > 0 && (
                  <div style={{ background: "rgba(0, 180, 255, 0.15)", border: "1px solid #00b4ff", padding: "6px 10px", borderRadius: "4px", marginBottom: "10px", fontSize: "10px", color: "#88ddff" }}>
                    🔥 Laptop Hotspot Device Detected:{" "}
                    {diagnostics.hotspotIps.map((ip) => (
                      <button
                        key={ip}
                        type="button"
                        onClick={() => setBluetoothIp(`${ip}:38765`)}
                        style={{
                          background: "#00b4ff",
                          color: "#000",
                          border: "none",
                          borderRadius: "3px",
                          padding: "2px 6px",
                          fontSize: "9px",
                          fontWeight: "bold",
                          marginLeft: "4px",
                          cursor: "pointer",
                        }}
                      >
                        {ip} (Fill)
                      </button>
                    ))}
                  </div>
                )}

                {diagnostics?.discoveredMdnsDevice && (
                  <div style={{ background: "rgba(0,255,150,0.15)", border: "1px solid #00ffaa", padding: "6px 10px", borderRadius: "4px", marginBottom: "10px", fontSize: "10px", color: "#88ffcc" }}>
                    ✨ Discovered phone on Wi-Fi at: <code>{diagnostics.discoveredMdnsDevice}</code>
                  </div>
                )}

                <div className="guide-steps" style={{ fontSize: "10px", lineHeight: "1.4" }}>
                  <div className="step">
                    <span className="step-num">1</span>
                    <span>Connect phone to your <strong>Laptop Mobile Hotspot</strong> or Wi-Fi.</span>
                  </div>
                  <div className="step">
                    <span className="step-num">2</span>
                    <span>On phone: <strong>Settings → Developer Options</strong> → TAP DIRECTLY ON THE TEXT <strong>"Wireless Debugging"</strong> (not just the switch!).</span>
                  </div>
                  <div className="step">
                    <span className="step-num">3</span>
                    <span>Copy the <strong>IP &amp; PORT</strong> shown inside that menu (e.g. <code>192.168.137.37:38765</code>) and click <strong>CONNECT PHONE NOW</strong>.</span>
                  </div>
                </div>

                <div className="ip-pair-form" style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div>
                    <label style={{ fontSize: "9px", opacity: 0.8, display: "block", marginBottom: "3px", color: "#88ffcc" }}>
                      PHONE IP ADDRESS &amp; PORT (e.g. 192.168.137.37:38765):
                    </label>
                    <input
                      type="text"
                      value={bluetoothIp}
                      onChange={(e) => setBluetoothIp(e.target.value)}
                      placeholder="192.168.137.37:38765"
                      className="command-input"
                      style={{ width: "100%", border: "1px solid var(--hud-border)", borderRadius: "3px", padding: "6px 10px", fontSize: "11px", fontFamily: "monospace" }}
                    />
                  </div>

                  <button
                    type="button"
                    className="modal-btn-primary"
                    style={{ padding: "8px", fontWeight: "bold", background: "var(--hud-color)", color: "#000" }}
                    onClick={() => {
                      dispatchAction("pair_bluetooth", {
                        deviceIp: bluetoothIp,
                      });
                      setShowSetupGuide(false);
                    }}
                  >
                    ⚡ CONNECT PHONE NOW
                  </button>

                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "10px", marginTop: "4px" }}>
                    <div style={{ fontSize: "9px", opacity: 0.7, marginBottom: "4px" }}>
                      ALTERNATIVE: Plug phone into USB cable ONCE and click below to permanently enable Wireless ADB on Port 5555:
                    </div>
                    <button
                      type="button"
                      className="dev-btn"
                      style={{ width: "100%", padding: "6px", fontSize: "9px" }}
                      onClick={() => {
                        dispatchAction("enable_tcpip");
                      }}
                    >
                      🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
                    </button>
                  </div>
                </div>

                <div className="modal-actions" style={{ marginTop: "16px" }}>
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
        )}
      </>
    );
  }

  const isLocked = activeDev.isLocked;
  const currentAppUpper = (activeDev.currentApp || "SYSTEM LAUNCHER").toUpperCase();
  const isPhysical = activeDev.isPhysical;
  const isIos = activeDev.os === "iOS";



  return (
    <>
      <aside className="device-hud-panel" aria-label="Connected Devices HUD Panel">
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
        <div className="device-screen-preview">
          <div className="screen-frame">
            <div className="screen-notch" />
            <div className="screen-content" data-app={currentAppUpper}>
              {activeDev.screenshotUrl ? (
                <img
                  src={activeDev.screenshotUrl}
                  alt="Captured Device Screen"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : isLocked ? (
                <div className="screen-locked">
                  <span className="lock-icon">🔒</span>
                  <span className="lock-text">{activeDev.name.toUpperCase()} LOCKED</span>
                  <span className="lock-sub">SAY "D-ASK UNLOCK PHONE"</span>
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
              onClick={() => {
                dispatchAction("enable_tcpip");
              }}
            >
              🔌 ENABLE WI-FI ADB PORT 5555 (VIA USB CABLE)
            </button>
          </div>
        </div>
      </aside>

      {/* Add New Device Modal (iPhone / Android) */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
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
      {showSetupGuide && (
        <div className="modal-backdrop" onClick={() => setShowSetupGuide(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>WIRELESS PHONE CONNECTION GUIDE</span>
              <button type="button" className="modal-close" onClick={() => setShowSetupGuide(false)}>✕</button>
            </div>
            <div className="modal-body">
              {diagnostics?.discoveredMdnsDevice && (
                <div style={{ background: "rgba(0,255,150,0.15)", border: "1px solid #00ffaa", padding: "6px 10px", borderRadius: "4px", marginBottom: "10px", fontSize: "10px", color: "#88ffcc" }}>
                  ✨ Discovered active phone at: <code>{diagnostics.discoveredMdnsDevice}</code>
                </div>
              )}

              <div className="guide-steps" style={{ fontSize: "10px", lineHeight: "1.4" }}>
                <div className="step">
                  <span className="step-num">1</span>
                  <span>Connect phone and PC to the <strong>same Wi-Fi network</strong>.</span>
                </div>
                <div className="step">
                  <span className="step-num">2</span>
                  <span>On your phone: Open <strong>Settings → Developer Options → Wireless Debugging</strong>.</span>
                </div>
                <div className="step">
                  <span className="step-num">3</span>
                  <span>Enter the <strong>IP Address &amp; Port</strong> shown on your phone screen below and click <strong>CONNECT PHONE NOW</strong>.</span>
                </div>
              </div>

              <div className="ip-pair-form" style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <div>
                  <label style={{ fontSize: "9px", opacity: 0.8, display: "block", marginBottom: "3px" }}>PHONE IP ADDRESS &amp; PORT:</label>
                  <input
                    type="text"
                    value={bluetoothIp}
                    onChange={(e) => setBluetoothIp(e.target.value)}
                    placeholder="192.168.137.38:37517"
                    className="command-input"
                    style={{ width: "100%", border: "1px solid var(--hud-border)", borderRadius: "3px", padding: "6px 10px", fontSize: "11px", fontFamily: "monospace" }}
                  />
                </div>

                <button
                  type="button"
                  className="modal-btn-primary"
                  style={{ padding: "8px", fontWeight: "bold" }}
                  onClick={() => {
                    dispatchAction("pair_bluetooth", {
                      deviceIp: bluetoothIp,
                    });
                    setShowSetupGuide(false);
                  }}
                >
                  ⚡ CONNECT PHONE NOW
                </button>
              </div>

              <div className="modal-actions" style={{ marginTop: "16px" }}>
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
      )}
    </>
  );
}
