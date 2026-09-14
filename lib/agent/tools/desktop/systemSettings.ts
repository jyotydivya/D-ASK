import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class SystemSettingsService {
  public async volumeUp(steps: number = 5): Promise<{ success: boolean; message: string }> {
    const psScript = `
$obj = new-object -com wscript.shell
for($i=0; $i -lt ${steps}; $i++) { $obj.SendKeys([char]175) }
`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 5000 });
      return { success: true, message: `Volume increased by ${steps} steps.` };
    } catch (err) {
      return { success: false, message: `Failed: ${err}` };
    }
  }

  public async volumeDown(steps: number = 5): Promise<{ success: boolean; message: string }> {
    const psScript = `
$obj = new-object -com wscript.shell
for($i=0; $i -lt ${steps}; $i++) { $obj.SendKeys([char]174) }
`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 5000 });
      return { success: true, message: `Volume decreased by ${steps} steps.` };
    } catch (err) {
      return { success: false, message: `Failed: ${err}` };
    }
  }

  public async toggleMute(): Promise<{ success: boolean; message: string }> {
    const psScript = `$obj = new-object -com wscript.shell; $obj.SendKeys([char]173)`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 5000 });
      return { success: true, message: `Mute toggled.` };
    } catch (err) {
      return { success: false, message: `Failed: ${err}` };
    }
  }

  public async setBrightness(level: number): Promise<{ success: boolean; message: string }> {
    const brightness = Math.max(0, Math.min(100, level));
    const psScript = `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${brightness})`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript], { timeout: 5000 });
      return { success: true, message: `Brightness set to ${brightness}%` };
    } catch (err) {
      return { success: false, message: `Failed (Are you on a desktop monitor? WMI only works for laptops/built-in displays): ${err}` };
    }
  }
}

export const systemSettingsService = new SystemSettingsService();
