import { execFile, exec } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class PCControlService {
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
  private discoverApplication(appName: string): string | null {
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
      return { success: true, message: `Launch command issued for ${appName}. Check screen.` };
    }
  }

  /**
   * Close an application by process name.
   */
  public async closeApplication(appName: string): Promise<{ success: boolean; message: string }> {
    try {
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

  /**
   * Power Management
   */
  public async setPowerState(state: "sleep" | "shutdown" | "restart" | "lock"): Promise<{ success: boolean; message: string }> {
    try {
      let command = "";
      switch (state) {
        case "sleep":
          command = "rundll32.exe powrprof.dll,SetSuspendState 0,1,0";
          break;
        case "shutdown":
          command = "shutdown /s /t 0";
          break;
        case "restart":
          command = "shutdown /r /t 0";
          break;
        case "lock":
          command = "rundll32.exe user32.dll,LockWorkStation";
          break;
      }
      if (command) {
        await execFileAsync("cmd.exe", ["/c", command], { timeout: 5000 });
      }
      return { success: true, message: `System ${state} command executed.` };
    } catch (err) {
      return { success: false, message: `Failed to execute ${state}: ${err}` };
    }
  }

  /**
   * Window Management (Active Window)
   */
  public async manageActiveWindow(action: "minimize" | "maximize" | "close"): Promise<{ success: boolean; message: string }> {
    const psScript = `
      $obj = new-object -com wscript.shell
      if ("${action}" -eq "minimize") {
        $obj.SendKeys("% n")
      } elseif ("${action}" -eq "maximize") {
        $obj.SendKeys("% x")
      } elseif ("${action}" -eq "close") {
        $obj.SendKeys("%{F4}")
      }
    `;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 5000 });
      return { success: true, message: `Active window ${action} command sent.` };
    } catch (err) {
      return { success: false, message: `Failed to manage window: ${err}` };
    }
  }
}

export const pcControlService = new PCControlService();
