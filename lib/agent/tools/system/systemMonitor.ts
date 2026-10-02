// ─────────────────────────────────────────────────────────────────────────────
// D-ASK System Monitor — Real-time system metrics
// Ported from Mark-LV actions/system_monitor.py — CPU, RAM, disk, GPU,
// network, uptime, and battery info via PowerShell/WMI.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface SystemMetrics {
  cpu: { usagePercent: number; name: string; cores: number; frequency: string };
  memory: { totalGB: number; usedGB: number; freeGB: number; usagePercent: number };
  disk: { drive: string; totalGB: number; freeGB: number; usagePercent: number }[];
  gpu: { name: string; memoryMB: number; driverVersion: string } | null;
  network: { adapter: string; status: string; speed: string } | null;
  battery: { percent: number; charging: boolean } | null;
  uptime: string;
  os: string;
}

export class SystemMonitorService {
  /**
   * Get comprehensive system status in one call.
   */
  public async getSystemStatus(): Promise<{ success: boolean; message: string; metrics?: SystemMetrics }> {
    const psScript = `
$ProgressPreference = 'SilentlyContinue'

# CPU
$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$cpuLoad = (Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average

# Memory
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$totalMem = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$freeMem = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$usedMem = [math]::Round($totalMem - $freeMem, 1)
$memPct = [math]::Round(($usedMem / $totalMem) * 100, 0)

# Disk
$disks = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  @{
    drive = $_.DeviceID
    totalGB = [math]::Round($_.Size / 1GB, 1)
    freeGB = [math]::Round($_.FreeSpace / 1GB, 1)
    usagePct = if ($_.Size -gt 0) { [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 0) } else { 0 }
  }
}

# GPU
$gpu = Get-CimInstance -ClassName Win32_VideoController | Select-Object -First 1

# Network
$net = Get-CimInstance -ClassName Win32_NetworkAdapter | Where-Object { $_.NetConnectionStatus -eq 2 } | Select-Object -First 1

# Battery
$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1

# Uptime
$bootTime = $os.LastBootUpTime
$uptime = (Get-Date) - $bootTime
$uptimeStr = "$([math]::Floor($uptime.TotalDays))d $($uptime.Hours)h $($uptime.Minutes)m"

$result = @{
  cpu = @{
    usagePercent = [int]$cpuLoad
    name = $cpu.Name.Trim()
    cores = [int]$cpu.NumberOfLogicalProcessors
    frequency = "$([math]::Round($cpu.MaxClockSpeed / 1000, 1)) GHz"
  }
  memory = @{
    totalGB = $totalMem
    usedGB = $usedMem
    freeGB = $freeMem
    usagePercent = [int]$memPct
  }
  disk = $disks
  gpu = if ($gpu) {
    @{
      name = $gpu.Name
      memoryMB = [math]::Round($gpu.AdapterRAM / 1MB, 0)
      driverVersion = $gpu.DriverVersion
    }
  } else { $null }
  network = if ($net) {
    @{
      adapter = $net.Name
      status = "Connected"
      speed = "$([math]::Round($net.Speed / 1000000, 0)) Mbps"
    }
  } else { $null }
  battery = if ($battery) {
    @{
      percent = [int]$battery.EstimatedChargeRemaining
      charging = ($battery.BatteryStatus -eq 2)
    }
  } else { $null }
  uptime = $uptimeStr
  os = "$($os.Caption) $($os.Version)"
}

$result | ConvertTo-Json -Depth 3 -Compress
`;

    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 15000 });

      const metrics = JSON.parse(stdout.trim()) as SystemMetrics;

      // Build human-readable summary
      const lines = [
        `💻 System Status:`,
        ``,
        `CPU: ${metrics.cpu.name}`,
        `  Usage: ${metrics.cpu.usagePercent}% | Cores: ${metrics.cpu.cores} | ${metrics.cpu.frequency}`,
        ``,
        `RAM: ${metrics.memory.usedGB}/${metrics.memory.totalGB} GB (${metrics.memory.usagePercent}%)`,
        ``,
      ];

      if (Array.isArray(metrics.disk)) {
        for (const d of metrics.disk) {
          lines.push(`Disk ${d.drive}: ${d.freeGB} GB free of ${d.totalGB} GB (${d.usagePercent}% used)`);
        }
      }

      if (metrics.gpu) {
        lines.push(`\nGPU: ${metrics.gpu.name}`);
        if (metrics.gpu.memoryMB > 0) {
          lines.push(`  VRAM: ${metrics.gpu.memoryMB} MB`);
        }
      }

      if (metrics.network) {
        lines.push(`\nNetwork: ${metrics.network.adapter} — ${metrics.network.status} (${metrics.network.speed})`);
      }

      if (metrics.battery) {
        lines.push(`\nBattery: ${metrics.battery.percent}% ${metrics.battery.charging ? "(Charging)" : "(On battery)"}`);
      }

      lines.push(`\nUptime: ${metrics.uptime}`);
      lines.push(`OS: ${metrics.os}`);

      return {
        success: true,
        message: lines.join("\n"),
        metrics,
      };
    } catch (err) {
      return {
        success: false,
        message: `System monitor error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get running processes sorted by CPU or memory usage.
   */
  public async getTopProcesses(sortBy: "cpu" | "memory" = "cpu", limit: number = 10): Promise<{ success: boolean; message: string }> {
    const sortField = sortBy === "cpu" ? "CPU" : "WorkingSet64";
    const psScript = `
$ProgressPreference = 'SilentlyContinue'
Get-Process | Sort-Object -Property ${sortField} -Descending | Select-Object -First ${limit} |
  ForEach-Object {
    @{
      name = $_.ProcessName
      pid = $_.Id
      cpuSeconds = [math]::Round($_.CPU, 1)
      memoryMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
    }
  } | ConvertTo-Json -Compress
`;

    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 10000 });

      const processes = JSON.parse(stdout.trim());
      const list = Array.isArray(processes) ? processes : [processes];

      const formatted = list.map((p: any, i: number) =>
        `${i + 1}. ${p.name} (PID: ${p.pid}) — CPU: ${p.cpuSeconds}s, RAM: ${p.memoryMB} MB`
      ).join("\n");

      return {
        success: true,
        message: `Top ${limit} processes by ${sortBy}:\n\n${formatted}`,
      };
    } catch (err) {
      return { success: false, message: `Failed to get processes: ${err}` };
    }
  }

  /**
   * Get network connectivity info including IP and connected WiFi.
   */
  public async getNetworkInfo(): Promise<{ success: boolean; message: string }> {
    const psScript = `
$ProgressPreference = 'SilentlyContinue'
$adapters = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 3
$wifi = netsh wlan show interfaces 2>$null | Select-String 'SSID' | Select-Object -First 1

$result = @{
  localIPs = ($adapters | ForEach-Object { $_.IPAddress }) -join ', '
  wifi = if ($wifi) { ($wifi -replace '.*SSID\s*:\s*', '').Trim() } else { 'Not connected' }
}
$result | ConvertTo-Json -Compress
`;

    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 10000 });

      const info = JSON.parse(stdout.trim());
      return {
        success: true,
        message: `🌐 Network Info:\n  Local IPs: ${info.localIPs}\n  WiFi: ${info.wifi}`,
      };
    } catch (err) {
      return { success: false, message: `Network info error: ${err}` };
    }
  }
}

export const systemMonitorService = new SystemMonitorService();
