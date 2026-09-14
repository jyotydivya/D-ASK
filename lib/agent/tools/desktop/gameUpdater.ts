import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class GameUpdaterService {
  public async launchSteam(): Promise<{ success: boolean; message: string }> {
    try {
      await execFileAsync("cmd.exe", ["/c", `start steam://open/main`], { timeout: 5000 });
      return { success: true, message: `Opened Steam.` };
    } catch (err) {
      return { success: false, message: `Failed to open Steam: ${err}` };
    }
  }

  public async launchEpicGames(): Promise<{ success: boolean; message: string }> {
    try {
      await execFileAsync("cmd.exe", ["/c", `start com.epicgames.launcher://apps/`], { timeout: 5000 });
      return { success: true, message: `Opened Epic Games Launcher.` };
    } catch (err) {
      return { success: false, message: `Failed to open Epic Games: ${err}` };
    }
  }
}

export const gameUpdaterService = new GameUpdaterService();
