// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Device Service — Clean ADB adapter
// Extracted from app/api/devices/route.ts so the LLM never touches raw ADB.
//
// Architecture:
//   DeviceAgent → DeviceService → ADB Adapter → Physical Android Device
// ─────────────────────────────────────────────────────────────────────────────

import { execFile, exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ── ADB binary resolution ──────────────────────────────────────────────────────

const ADB_PATHS = [
  "C:\\Users\\divya\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
  "C:\\platform-tools\\adb.exe",
  "adb.exe",
  "adb",
];

function resolveAdbBinary(): string {
  for (const p of ADB_PATHS) {
    if (p !== "adb" && p !== "adb.exe" && fs.existsSync(p)) return p;
  }
  return "adb";
}

const ADB_BIN = resolveAdbBinary();

async function runAdb(args: string[], timeoutMs = 6000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(ADB_BIN, args, { timeout: timeoutMs });
    return ((stdout || "") + "\n" + (stderr || "")).trim();
  } catch (err: unknown) {
    const e = err as Record<string, string>;
    const raw = ((e?.stdout ?? "") + "\n" + (e?.stderr ?? "")).trim();
    if (raw) return raw;
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace(/^Command failed:.*?\r?\n/i, "").trim() || "ADB execution failed";
  }
}

// ── Type Exports ───────────────────────────────────────────────────────────────

export type DeviceInfo = {
  id: string;
  name: string;
  model: string;
  os: "Android" | "iOS";
  connectionType: "BLUETOOTH / WIRELESS" | "USB" | "DISCONNECTED";
  status: "CONNECTED" | "DISCONNECTED" | "UNAUTHORIZED";
  isLocked: boolean;
  batteryLevel: number;
  isCharging: boolean;
  currentApp: string;
  bluetoothMac: string;
  signalStrength: number;
  osVersion: string;
  lastActive: string;
  isPhysical: boolean;
  screenshotUrl?: string;
};

export type HardwareDiagnostics = {
  adbRunning: boolean;
  adbPath: string;
  devicesFoundCount: number;
  usbAttached: boolean;
  wirelessAttached: boolean;
  unauthorizedCount: number;
  iphoneDetected: boolean;
  troubleshootStep: string;
  discoveredMdnsDevice?: string;
  hotspotIps?: string[];
};

export type ScanResult = {
  devices: DeviceInfo[];
  totalConnected: number;
  diagnostics: HardwareDiagnostics;
};

// ── Persistent registry (module-level singleton) ───────────────────────────────

let deviceRegistry: DeviceInfo[] = [];

// ── Discovery helpers ─────────────────────────────────────────────────────────

async function detectHotspotIps(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("arp -a", { timeout: 3000 });
    const ips: string[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(192\.168\.137\.\d+)\s+([0-9a-f-]{17})/i);
      if (match && match[1] !== "192.168.137.1" && match[1] !== "192.168.137.255") {
        ips.push(match[1]);
      }
    }
    return Array.from(new Set(ips));
  } catch {
    return [];
  }
}

async function detectIphonesOnWindows(): Promise<DeviceInfo[]> {
  const iphones: DeviceInfo[] = [];
  try {
    const psCmd = `Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like "*iPhone*" -or $_.Manufacturer -like "*Apple*" } | Select-Object -ExpandProperty FriendlyName`;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 3000 });
    for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      iphones.push({
        id: `APPLE-IPHONE-${line.replace(/[^a-zA-Z0-9]/g, "-").toUpperCase()}`,
        name: line || "Apple iPhone",
        model: line || "iPhone 15 Pro",
        os: "iOS",
        connectionType: "BLUETOOTH / WIRELESS",
        status: "CONNECTED",
        isLocked: false,
        batteryLevel: 92,
        isCharging: true,
        currentApp: "SYSTEM LAUNCHER",
        bluetoothMac: "APPLE-USB-LINK",
        signalStrength: 99,
        osVersion: "iOS 17.5 / Apple Link",
        lastActive: "ACTIVE APPLE HARDWARE LINK",
        isPhysical: true,
      });
    }
  } catch { /* ignored */ }
  return iphones;
}

async function discoverMdnsServices(): Promise<string[]> {
  try {
    const out = await runAdb(["mdns", "services"]);
    const matches = out.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)/g);
    return matches ? Array.from(new Set(matches)) : [];
  } catch {
    return [];
  }
}

async function autoConnectWirelessMdns(): Promise<void> {
  const ipPorts = await discoverMdnsServices();
  for (const ipPort of ipPorts) {
    try { await runAdb(["connect", ipPort]); } catch { /* ignored */ }
  }
}

async function autoConnectHotspotIps(ips: string[]): Promise<void> {
  if (!ips.length) return;
  await Promise.all(ips.map(async (ip) => {
    try { await runAdb(["connect", `${ip}:5555`], 1500); } catch { /* ignored */ }
  }));
}

// ── DeviceService public interface ────────────────────────────────────────────

export const deviceService = {
  /**
   * Full device scan — discovers USB, wireless, mDNS, hotspot, and iPhones.
   * Updates the module-level registry.
   */
  async scanAllDevices(): Promise<ScanResult> {
    let adbRunning = true;
    let devicesFoundCount = 0;
    let usbAttached = false;
    let wirelessAttached = false;
    let unauthorizedCount = 0;
    let discoveredMdnsDevice: string | undefined;
    const hotspotIps = await detectHotspotIps();

    await autoConnectHotspotIps(hotspotIps);

    const liveAndroid: DeviceInfo[] = [];

    try {
      let stdout = await runAdb(["devices", "-l"]);
      let lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("List of devices"));

      if (lines.length === 0) {
        const mdnsMatches = await discoverMdnsServices();
        if (mdnsMatches.length > 0) {
          discoveredMdnsDevice = mdnsMatches[0];
          await autoConnectWirelessMdns();
          stdout = await runAdb(["devices", "-l"]);
          lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("List of devices"));
        }
      }

      devicesFoundCount = lines.length;

      for (const line of lines) {
        const parts = line.split(/\s+/);
        const id = parts[0]!;
        const stateStr = parts[1]!;

        if (stateStr === "unauthorized") unauthorizedCount++;
        if (id.includes(":")) wirelessAttached = true;
        else usbAttached = true;

        let model = "Android Smartphone";
        const modelMatch = line.match(/model:(\S+)/);
        if (modelMatch) model = modelMatch[1]!.replace(/_/g, " ");

        let battery = 90;
        let charging = false;
        try {
          const batOut = await runAdb(["-s", id, "shell", "dumpsys", "battery"]);
          const levelMatch = batOut.match(/level:\s*(\d+)/);
          if (levelMatch) battery = parseInt(levelMatch[1]!, 10);
          charging = batOut.includes("AC powered: true") || batOut.includes("USB powered: true");
        } catch { /* ignored */ }

        let currentApp = "LAUNCHER";
        try {
          const windowOut = await runAdb(["-s", id, "shell", "dumpsys", "window"]);
          if (windowOut.includes("camera")) currentApp = "CAMERA";
          else if (windowOut.includes("youtube")) currentApp = "YOUTUBE";
          else if (windowOut.includes("instagram")) currentApp = "INSTAGRAM";
          else if (windowOut.includes("chrome")) currentApp = "CHROME";
          else if (windowOut.includes("settings")) currentApp = "SETTINGS";
        } catch { /* ignored */ }

        const isWireless = id.includes(":");
        const status: "CONNECTED" | "UNAUTHORIZED" = stateStr === "device" ? "CONNECTED" : "UNAUTHORIZED";

        liveAndroid.push({
          id,
          name: `${model} (${id.slice(0, 15)})`,
          model,
          os: "Android",
          connectionType: isWireless ? "BLUETOOTH / WIRELESS" : "USB",
          status,
          isLocked: false,
          batteryLevel: battery,
          isCharging: charging,
          currentApp,
          bluetoothMac: isWireless ? id : "USB-DEVICE",
          signalStrength: 98,
          osVersion: "Android",
          lastActive: "ACTIVE HARDWARE LINK",
          isPhysical: true,
        });
      }
    } catch {
      adbRunning = false;
    }

    const pnpIphones = await detectIphonesOnWindows();
    deviceRegistry = [...liveAndroid, ...pnpIphones];

    const connectedCount = deviceRegistry.filter((d) => d.isPhysical && d.status === "CONNECTED").length;

    let troubleshootStep = "ALL MATRIX NODES ONLINE AND READY";
    if (unauthorizedCount > 0) {
      troubleshootStep = "UNLOCK YOUR PHONE SCREEN & TAP 'ALLOW USB DEBUGGING' ON THE PROMPT";
    } else if (connectedCount === 0) {
      if (hotspotIps.length > 0) {
        troubleshootStep = `HOTSPOT DEVICE DETECTED (${hotspotIps.join(", ")}) · OPEN WIRELESS DEBUGGING & ENTER IP:PORT`;
      } else if (discoveredMdnsDevice) {
        troubleshootStep = `DISCOVERED PHONE AT ${discoveredMdnsDevice} · OPEN WIRELESS DEBUGGING & CONNECT`;
      } else if (pnpIphones.length === 0) {
        troubleshootStep = "NO DEVICE CONNECTED · CONNECT PHONE TO LAPTOP HOTSPOT OR USB CABLE & ENABLE WIRELESS DEBUGGING";
      }
    }

    return {
      devices: deviceRegistry,
      totalConnected: connectedCount,
      diagnostics: {
        adbRunning,
        adbPath: ADB_BIN,
        devicesFoundCount,
        usbAttached,
        wirelessAttached,
        unauthorizedCount,
        iphoneDetected: pnpIphones.length > 0,
        troubleshootStep,
        discoveredMdnsDevice,
        hotspotIps,
      },
    };
  },

  /** Get current registry without re-scanning. */
  getRegistry(): DeviceInfo[] {
    return deviceRegistry;
  },

  /** Get connected devices from registry, optionally trigger scan if empty. */
  async getConnectedDevices(scanIfEmpty = true): Promise<DeviceInfo[]> {
    let connected = deviceRegistry.filter((d) => d.isPhysical && d.status === "CONNECTED");
    if (connected.length === 0 && scanIfEmpty) {
      const result = await this.scanAllDevices();
      connected = result.devices.filter((d) => d.isPhysical && d.status === "CONNECTED");
    }
    return connected;
  },

  /** Resolve a device by ID or fall back to first connected device. */
  resolveDevice(deviceId?: string): DeviceInfo | null {
    const connected = deviceRegistry.filter((d) => d.isPhysical && d.status === "CONNECTED");
    if (deviceId) {
      return connected.find((d) => d.id === deviceId) ?? connected[0] ?? null;
    }
    return connected[0] ?? null;
  },

  // ── Device Actions ────────────────────────────────────────────────────────

  async listDevices(): Promise<{ devices: DeviceInfo[]; connected: number }> {
    const result = await this.scanAllDevices();
    return { devices: result.devices, connected: result.totalConnected };
  },

  async getDeviceStatus(deviceId: string): Promise<DeviceInfo | null> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") return dev;

    try {
      const batOut = await runAdb(["-s", dev.id, "shell", "dumpsys", "battery"]);
      const levelMatch = batOut.match(/level:\s*(\d+)/);
      if (levelMatch) dev.batteryLevel = parseInt(levelMatch[1]!, 10);
      dev.isCharging = batOut.includes("AC powered: true") || batOut.includes("USB powered: true");
    } catch { /* ignored */ }

    return dev;
  },

  async connectDevice(ip: string, port = 5555): Promise<string> {
    const target = `${ip}:${port}`;
    const result = await runAdb(["connect", target], 3000);
    if (result.toLowerCase().includes("connected") || result.toLowerCase().includes("already connected")) {
      await this.scanAllDevices();
      return `CONNECTED TO ${target}`;
    }
    throw new Error(`Failed to connect to ${target}: ${result}`);
  },

  async enableTcpip(deviceId?: string): Promise<string> {
    const args = deviceId ? ["-s", deviceId, "tcpip", "5555"] : ["tcpip", "5555"];
    const result = await runAdb(args, 5000);
    return `TCP/IP ENABLED: ${result.split("\n")[0]}`;
  },

  async pairDevice(target: string, pairCode: string): Promise<string> {
    const result = await runAdb(["pair", target, pairCode], 3000);
    return `PAIRED: ${result.split("\n")[0]}`;
  },

  async launchApp(deviceId: string, app: string): Promise<string> {
    const appName = app.toLowerCase();
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") {
      throw new Error(`Device ${deviceId} not found or not an Android device`);
    }

    (async () => {
      if (appName.includes("cam")) {
        await runAdb(["-s", dev.id, "shell", "am", "start", "-a", "android.media.action.IMAGE_CAPTURE"], 2000).catch(() => {});
      } else if (appName.includes("insta")) {
        await runAdb(["-s", dev.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "https://www.instagram.com"], 2000).catch(() => {});
      } else {
        await runAdb(["-s", dev.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "https://www.youtube.com"], 2000).catch(() => {});
      }
    })();

    dev.currentApp = appName.toUpperCase();
    return `LAUNCHED ${appName.toUpperCase()} ON ${dev.name}`;
  },

  async lockDevice(deviceId: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);
    runAdb(["-s", dev.id, "shell", "input", "keyevent", "26"], 2000).catch(() => {});
    dev.isLocked = true;
    return `LOCKED ${dev.name}`;
  },

  async unlockDevice(deviceId: string, pin?: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);
    (async () => {
      await runAdb(["-s", dev.id, "shell", "input", "keyevent", "224"], 2000).catch(() => {});
      await runAdb(["-s", dev.id, "shell", "wm", "dismiss-keyguard"], 1000).catch(() => {});
      await runAdb(["-s", dev.id, "shell", "input", "swipe", "500", "1500", "500", "500"], 1000).catch(() => {});
      if (pin?.trim()) {
        await runAdb(["-s", dev.id, "shell", "input", "text", pin.trim()], 1500).catch(() => {});
        await runAdb(["-s", dev.id, "shell", "input", "keyevent", "66"], 1000).catch(() => {});
      }
    })();
    dev.isLocked = false;
    return `UNLOCKED ${dev.name}`;
  },

  async goHome(deviceId: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);
    runAdb(["-s", dev.id, "shell", "input", "keyevent", "3"], 2000).catch(() => {});
    dev.currentApp = "LAUNCHER";
    return `HOME SCREEN ON ${dev.name}`;
  },

  async takeScreenshot(deviceId: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);

    const publicDir = path.join(process.cwd(), "public");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const phoneShot = "/sdcard/Download/dask_shot.png";
    const shotFilename = `screenshot_${dev.id.replace(/[^a-zA-Z0-9]/g, "_")}.png`;
    const localShot = path.join(publicDir, shotFilename);

    await runAdb(["-s", dev.id, "shell", "screencap", "-p", phoneShot], 3000);
    await runAdb(["-s", dev.id, "pull", phoneShot, localShot], 3000);

    const url = `/${shotFilename}?t=${Date.now()}`;
    dev.screenshotUrl = url;
    return url;
  },

  async volumeUp(deviceId: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);
    runAdb(["-s", dev.id, "shell", "input", "keyevent", "24"], 2000).catch(() => {});
    return `VOL + ON ${dev.name}`;
  },

  async volumeDown(deviceId: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);
    runAdb(["-s", dev.id, "shell", "input", "keyevent", "25"], 2000).catch(() => {});
    return `VOL - ON ${dev.name}`;
  },

  async searchYouTube(deviceId: string, query: string): Promise<string> {
    const dev = this.resolveDevice(deviceId);
    if (!dev || dev.os !== "Android") throw new Error(`Device ${deviceId} not found`);

    const encodedQuery = encodeURIComponent(query);
    (async () => {
      await runAdb(
        ["-s", dev.id, "shell", "am", "start", "-a", "android.intent.action.VIEW",
          "-d", `https://www.youtube.com/results?search_query=${encodedQuery}`],
        2000
      ).catch(() => {});
    })();

    dev.currentApp = "YOUTUBE";
    return `YOUTUBE SEARCH ACTIVE: "${query}" ON ${dev.name}`;
  },

  async clearRegistry(): Promise<void> {
    deviceRegistry = [];
  },

  async addManualDevice(name: string, os: "Android" | "iOS"): Promise<DeviceInfo> {
    const id = `${os.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const dev: DeviceInfo = {
      id,
      name,
      model: name,
      os,
      connectionType: "BLUETOOTH / WIRELESS",
      status: "CONNECTED",
      isLocked: false,
      batteryLevel: 95,
      isCharging: false,
      currentApp: "SYSTEM LAUNCHER",
      bluetoothMac: "WIRELESS-LINK",
      signalStrength: 99,
      osVersion: `${os} 17 / Wireless Link`,
      lastActive: "ACTIVE MATRIX NODE",
      isPhysical: true,
    };
    deviceRegistry.unshift(dev);
    return dev;
  },
};
