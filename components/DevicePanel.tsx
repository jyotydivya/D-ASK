"use client";

import React, { useEffect, useState } from "react";
import type { DeviceInfo } from "@/app/api/devices/route";

interface DevicePanelProps {
  device: DeviceInfo | null;
  hasPhysicalDevice?: boolean;
  onControlDevice: (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string; pinCode?: string; targetDeviceId?: string; broadcastAll?: boolean; newDeviceName?: string; newDeviceOs?: "Android" | "iOS" }) => void;
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
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [broadcastAll, setBroadcastAll] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [bluetoothIp, setBluetoothIp] = useState("192.168.137.37:37517");
  const [newDevName, setNewDevName] = useState("iPhone 15 Pro");
  const [newDevOs, setNewDevOs] = useState<"Android" | "iOS">("iOS");
  const [savedPin, setSavedPin] = useState("");

  // Poll list of all devices
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const res = await fetch("/api/devices");
        const data = (await res.json()) as { devices?: DeviceInfo[]; activeDevice?: DeviceInfo };
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
    const interval = setInterval(fetchAll, 3000);
    return () => clearInterval(interval);
  }, [selectedDeviceId]);

  useEffect(() => {
    const pin = window.localStorage.getItem("ultron-device-pin");
    if (pin) setSavedPin(pin);
  }, []);

  const updatePin = (pin: string) => {
    setSavedPin(pin);
    window.localStorage.setItem("ultron-device-pin", pin);
  };

  const activeDev = devicesList.find((d) => d.id === selectedDeviceId) || device;

  if (!activeDev) {
    return (
      <div className="device-hud-panel">
        <div className="device-header">
          <span className="device-title">CONNECTED DEVICES</span>
          <span className="device-status-badge status-offline">OFFLINE</span>
        </div>
        <p className="device-empty">SEARCHING MULTI-DEVICE NODES...</p>
      </div>
    );
  }

  const isLocked = activeDev.isLocked;
  const currentAppUpper = (activeDev.currentApp || "SYSTEM LAUNCHER").toUpperCase();
  const isPhysical = activeDev.isPhysical;
  const isIos = activeDev.os === "iOS";

  const dispatchAction = (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string }) => {
    onControlDevice(action, {
      ...payload,
      targetDeviceId: selectedDeviceId,
      broadcastAll,
      pinCode: savedPin,
    });
  };

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
            title="Toggle Broadcast to All Connected Devices"
            style={{ cursor: "pointer" }}
          >
            {broadcastAll ? "⚡ BROADCAST ALL" : "SINGLE DEVICE"}
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

          {/* Pair Bar */}
          <div className="action-row setup-row">
            <button
              type="button"
              className="dev-btn setup-btn"
              onClick={() => {
                if (onRefreshDevices) onRefreshDevices();
                setShowSetupGuide(true);
              }}
            >
              ᛟ PAIR BLUETOOTH / WIRELESS
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
                    onControlDevice("add_device", { newDeviceName: newDevName, newDeviceOs: newDevOs });
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

      {/* Bluetooth Setup Guide Modal */}
      {showSetupGuide && (
        <div className="modal-backdrop" onClick={() => setShowSetupGuide(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>BLUETOOTH 5.3 / WIRELESS LINK GUIDE</span>
              <button type="button" className="modal-close" onClick={() => setShowSetupGuide(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p><strong>Active Protocol:</strong> <code>BLUETOOTH 5.3 / WIRELESS ADB</code></p>

              <div className="guide-steps">
                <div className="step">
                  <span className="step-num">1</span>
                  <span>Turn on <strong>Wireless Debugging / Bluetooth</strong> on your phone.</span>
                </div>
                <div className="step">
                  <span className="step-num">2</span>
                  <span>Enter your phone's Wireless IP Address & Port below (e.g. <code>192.168.137.37:37517</code>).</span>
                </div>
              </div>

              <div className="ip-pair-form" style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={bluetoothIp}
                  onChange={(e) => setBluetoothIp(e.target.value)}
                  placeholder="192.168.137.37:37517"
                  className="command-input"
                  style={{ border: "1px solid var(--hud-border)", borderRadius: "3px", padding: "4px 8px" }}
                />
                <button
                  type="button"
                  className="modal-btn-primary"
                  onClick={() => {
                    onControlDevice("pair_bluetooth", { deviceIp: bluetoothIp });
                    setShowSetupGuide(false);
                  }}
                >
                  PAIR DEVICE
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
                  SCAN ALL MATRIX NODES
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
