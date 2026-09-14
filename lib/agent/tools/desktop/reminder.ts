import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class ReminderService {
  public async setReminder(minutes: number, message: string): Promise<{ success: boolean; message: string }> {
    const seconds = Math.floor(minutes * 60);
    const safeMessage = message.replace(/'/g, "''");
    
    // We launch a background PowerShell process that sleeps and then shows a message box
    const psScript = `
Start-Sleep -Seconds ${seconds}
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('${safeMessage}', 'D-ASK Reminder')
`;
    
    try {
      // Execute asynchronously detached (do not await if we want it to run in background, but child_process execFile doesn't detach easily without spawn.
      // Wait, we can use Start-Process to detach it in PowerShell.)
      const launcherScript = `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "${psScript.replace(/\n/g, '; ')}"`;
      
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", launcherScript], { timeout: 5000 });
      return { success: true, message: `Reminder set for ${minutes} minutes from now.` };
    } catch (err) {
      return { success: false, message: `Failed to set reminder: ${err}` };
    }
  }
}

export const reminderService = new ReminderService();
