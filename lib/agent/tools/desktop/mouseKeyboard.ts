import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

// Phase 4B-1R.6: commands that produce real OS input events are blocked at this
// layer (defense-in-depth behind the pcAgent routing guard). Read-only commands
// (take_screenshot, size, position) are explicitly allowed through.
const BLOCKED_SIDECAR_COMMANDS = new Set([
  "mouse_move", "mouse_click", "mouse_scroll", "type_text", "press_key", "hotkey",
]);

/**
 * Interface to the Python PyAutoGUI sidecar.
 */
export class MouseKeyboardController {
  private pythonScriptPath: string;

  constructor() {
    this.pythonScriptPath = path.join(process.cwd(), "lib", "agent", "tools", "desktop", "python", "mouse_keyboard.py");
  }

  private async runCommand(command: string, args: Record<string, unknown>): Promise<any> {
    if (BLOCKED_SIDECAR_COMMANDS.has(command)) {
      throw new Error(
        `[Phase 4B-1R.6 containment] PyAutoGUI command "${command}" is blocked. ` +
        "OS input injection is not authorized until Phase 4B-2 is separately approved."
      );
    }
    try {
      const { stdout } = await execFileAsync("python", [
        this.pythonScriptPath,
        command,
        JSON.stringify(args)
      ]);
      
      const result = JSON.parse(stdout.trim());
      if (!result.success) {
        throw new Error(result.error || "Unknown python sidecar error");
      }
      return result;
    } catch (error) {
      console.error(`[MouseKeyboardController] Error running ${command}:`, error);
      throw error;
    }
  }

  async getScreenSize(): Promise<{ width: number; height: number }> {
    const res = await this.runCommand("size", {});
    return res.size;
  }

  async getMousePosition(): Promise<{ x: number; y: number }> {
    const res = await this.runCommand("position", {});
    return res.position;
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.runCommand("mouse_move", { x, y });
  }

  async click(button: "left" | "right" | "middle" = "left", clicks: number = 1): Promise<void> {
    await this.runCommand("mouse_click", { button, clicks });
  }

  async scroll(amount: number): Promise<void> {
    await this.runCommand("mouse_scroll", { amount });
  }

  async typeText(text: string): Promise<void> {
    await this.runCommand("type_text", { text });
  }

  async pressKey(key: string): Promise<void> {
    await this.runCommand("press_key", { key });
  }

  async hotkey(keys: string[]): Promise<void> {
    await this.runCommand("hotkey", { keys });
  }

  /**
   * Captures the screen and returns it as a Base64 JPEG string.
   */
  async takeScreenshot(): Promise<string> {
    const res = await this.runCommand("take_screenshot", {});
    return res.image;
  }
}

export const mouseKeyboardService = new MouseKeyboardController();
