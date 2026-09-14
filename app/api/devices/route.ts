// ─────────────────────────────────────────────────────────────────────────────
// app/api/devices/route.ts — Thin HTTP adapter over DeviceService
// API interface is unchanged — DevicePanel.tsx requires NO modifications.
// All ADB logic now lives in tools/device/deviceService.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { deviceService } from "../../../tools/device/deviceService";

export const runtime = "nodejs";

// Re-export types so existing imports from this path still resolve
export type { DeviceInfo, HardwareDiagnostics, ScanResult } from "../../../tools/device/deviceService";

// ── GET /api/devices — Scan all devices ──────────────────────────────────────

export async function GET() {
  try {
    const result = await deviceService.scanAllDevices();

    return NextResponse.json({
      success: true,
      devices: result.devices,
      totalConnected: result.totalConnected,
      diagnostics: result.diagnostics,
      adbPath: result.diagnostics.adbPath,
      hasPhysicalDevice:
        result.devices.some((d) => d.isPhysical && d.status === "CONNECTED"),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[GET /api/devices]", error);
    return NextResponse.json(
      { success: false, error, devices: [], totalConnected: 0 },
      { status: 500 }
    );
  }
}

// ── POST /api/devices — Device commands ──────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      command?: string;
      action?: string;
      targetDeviceId?: string;
      deviceId?: string;
      broadcastAll?: boolean;
      ip?: string;
      port?: number;
      pairCode?: string;
      pairTarget?: string;
      app?: string;
      pin?: string;
      query?: string;
      manualDeviceName?: string;
      manualDeviceOs?: "Android" | "iOS";
      clearRegistry?: boolean;
      enableTcpip?: boolean;
    };

    const {
      command,
      action: bodyAction,
      targetDeviceId,
      deviceId,
      broadcastAll = false,
      ip,
      port,
      pairCode,
      pairTarget,
      app,
      pin,
      query,
      manualDeviceName,
      manualDeviceOs = "Android",
      clearRegistry,
      enableTcpip,
    } = body;

    // ── Clear Registry ──────────────────────────────────────────────────────

    if (clearRegistry) {
      await deviceService.clearRegistry();
      return NextResponse.json({ success: true, message: "Registry cleared" });
    }

    // ── Manual device add ───────────────────────────────────────────────────

    if (manualDeviceName) {
      const dev = await deviceService.addManualDevice(manualDeviceName, manualDeviceOs);
      return NextResponse.json({
        success: true,
        message: `Manual device "${manualDeviceName}" added.`,
        device: dev,
        devices: deviceService.getRegistry(),
      });
    }

    // ── Enable TCP/IP ───────────────────────────────────────────────────────

    if (enableTcpip) {
      const result = await deviceService.enableTcpip(targetDeviceId ?? deviceId);
      return NextResponse.json({ success: true, result });
    }

    // ── Pair device ──────────────────────────────────────────────────────────

    if (pairCode && pairTarget) {
      const result = await deviceService.pairDevice(pairTarget, pairCode);
      return NextResponse.json({ success: true, result });
    }

    // ── Wireless connect ─────────────────────────────────────────────────────

    if (command === "connect" || (ip && !pairCode)) {
      const connectIp = ip ?? "";
      if (!connectIp) {
        return NextResponse.json({ success: false, error: "IP is required for connect" }, { status: 400 });
      }
      const result = await deviceService.connectDevice(connectIp, port ?? 5555);
      const scan = await deviceService.scanAllDevices();
      return NextResponse.json({
        success: true,
        result,
        devices: scan.devices,
        totalConnected: scan.totalConnected,
      });
    }

    // ── Device Actions ────────────────────────────────────────────────────────

    const action = bodyAction ?? command;
    if (!action) {
      return NextResponse.json({ success: false, error: "action or command is required" }, { status: 400 });
    }

    const primaryId = targetDeviceId ?? deviceId;

    // Determine targets
    const registry = deviceService.getRegistry();
    const connectedPhysicals = registry.filter((d) => d.isPhysical && d.status === "CONNECTED");

    const targets = broadcastAll
      ? connectedPhysicals
      : primaryId
        ? [deviceService.resolveDevice(primaryId) ?? connectedPhysicals[0]].filter(Boolean)
        : [connectedPhysicals[0]].filter(Boolean);

    if (targets.length === 0) {
      return NextResponse.json({
        success: false,
        error: "NO CONNECTED DEVICE FOUND",
        devices: registry,
        totalConnected: 0,
      });
    }

    const results: string[] = [];
    let screenshotUrl: string | undefined;

    await Promise.all(
      targets.map(async (dev) => {
        if (!dev) return;
        try {
          let result: string;
          switch (action) {
            case "launch":
            case "launch_app":
              result = await deviceService.launchApp(dev.id, app ?? "youtube");
              break;
            case "lock":
              result = await deviceService.lockDevice(dev.id);
              break;
            case "unlock":
              result = await deviceService.unlockDevice(dev.id, pin);
              break;
            case "home":
              result = await deviceService.goHome(dev.id);
              break;
            case "take_screenshot":
            case "screenshot":
              screenshotUrl = await deviceService.takeScreenshot(dev.id);
              result = `SCREENSHOT: ${screenshotUrl}`;
              break;
            case "volume_up":
              result = await deviceService.volumeUp(dev.id);
              break;
            case "volume_down":
              result = await deviceService.volumeDown(dev.id);
              break;
            case "search_youtube":
              result = await deviceService.searchYouTube(dev.id, query ?? "");
              break;
            case "status":
              await deviceService.getDeviceStatus(dev.id);
              result = `STATUS: ${dev.model} (${dev.batteryLevel}%)`;
              break;
            default:
              result = `${dev.name}: EXECUTED ${action.toUpperCase()}`;
          }
          results.push(result);
        } catch (err) {
          results.push(`${dev.name}: ERROR - ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );

    const summary =
      targets.length > 1
        ? `⚡ BROADCASTED TO ALL ${targets.length} DEVICES: ${results.join(" · ")}`
        : results.join(" · ");

    const updatedRegistry = deviceService.getRegistry();
    const activeDevice = updatedRegistry.find((d) => d.id === primaryId) ?? updatedRegistry[0];

    return NextResponse.json({
      success: true,
      result: summary,
      devices: updatedRegistry,
      totalConnected: connectedPhysicals.length,
      activeDevice: activeDevice ?? null,
      hasPhysicalDevice: connectedPhysicals.length > 0,
      screenshotUrl,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/devices]", error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
