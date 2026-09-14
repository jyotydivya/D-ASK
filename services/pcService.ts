import { execFile, exec } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export class WindowsController {
  private readonly appRegistry: Record<string, string> = {
    // Browsers
    "youtube":        `start "" "https://www.youtube.com"`,
    "chrome":         `start chrome`,
    "google chrome":  `start chrome`,
    "edge":           `start msedge`,
    "firefox":        `start firefox`,
    // Productivity
    "notepad":        `notepad`,
    "paint":          `mspaint`,
    "ms paint":       `mspaint`,
    "calculator":     `calc`,
    "calc":           `calc`,
    "vscode":         `code`,
    "visual studio code": `code`,
    "word":           `start winword`,
    "excel":          `start excel`,
    "powerpoint":     `start powerpnt`,
    "calendar":       `start outlookcal:`,
    // System
    "task manager":   `taskmgr`,
    "file explorer":  `explorer`,
    "explorer":       `explorer`,
    "cmd":            `start cmd`,
    "terminal":       `wt`,
    "powershell":     `start powershell`,
    "settings":       `start ms-settings:`,
    "control panel":  `control`,
    // Media & Tools
    "spotify":        `start spotify:`,
    "snipping tool":  `snippingtool`,
    "screenshot":     `snippingtool`,
  };

  /**
   * Attempts to discover the application command based on the registry.
   */
  public discoverApplication(appName: string): string | null {
    const name = appName.toLowerCase().trim();
    
    if (this.appRegistry[name]) {
      return this.appRegistry[name]!;
    }
    
    // Partial match
    for (const [key, cmd] of Object.entries(this.appRegistry)) {
      if (name.includes(key) || key.includes(name)) {
        return cmd;
      }
    }
    
    return null;
  }

  /**
   * Launch an application.
   */
  public async launchApplication(appName: string): Promise<{ success: boolean; message: string }> {
    let command = this.discoverApplication(appName);
    
    if (!command) {
      // Fallback: try direct start
      command = `start "" "${appName}"`;
    }

    try {
      await execFileAsync("cmd.exe", ["/c", command], { timeout: 5000 });
      return { success: true, message: `Successfully launched ${appName}` };
    } catch (err) {
      // Many start commands "fail" with exit codes but still launch.
      // E.g., `start chrome` sometimes returns non-zero if chrome is already running.
      return { success: true, message: `Launch command issued for ${appName}. Check screen.` };
    }
  }

  /**
   * Close an application by process name.
   */
  public async closeApplication(appName: string): Promise<{ success: boolean; message: string }> {
    try {
      // Using Stop-Process which is slightly safer than taskkill, or taskkill directly
      // For simplicity in Phase 1, we will use taskkill
      const name = appName.endsWith('.exe') ? appName : `${appName}.exe`;
      await execFileAsync("taskkill", ["/IM", name, "/F"], { timeout: 5000 });
      return { success: true, message: `Successfully closed ${appName}` };
    } catch (err) {
      return { success: false, message: `Failed to close ${appName}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * List active main windows using PowerShell.
   */
  public async listWindows(): Promise<string[]> {
    const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { timeout: 10000 });
      return stdout.split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    } catch (err) {
      console.error("listWindows error:", err);
      return [];
    }
  }

  /**
   * Get the currently active/focused window title.
   * Requires a small C# inline compilation via PowerShell to call GetForegroundWindow.
   */
  public async getActiveWindow(): Promise<string> {
    const psCommand = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll", CharSet = CharSet.Auto)]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        }
"@
      $hwnd = [Win32]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      $res = [Win32]::GetWindowText($hwnd, $sb, $sb.Capacity)
      $sb.ToString()
    `;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { timeout: 5000 });
      return stdout.trim() || "Desktop / Explorer";
    } catch (err) {
      return "Unknown";
    }
  }
}

export const pcService = new WindowsController();
