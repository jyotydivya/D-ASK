import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class MessagingService {
  public async sendWhatsApp(message: string): Promise<{ success: boolean; message: string }> {
    const encoded = encodeURIComponent(message);
    const url = `whatsapp://send?text=${encoded}`;
    
    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened WhatsApp with message.` };
    } catch (err) {
      return { success: false, message: `Failed to open WhatsApp: ${err}` };
    }
  }

  public async sendTelegram(message: string): Promise<{ success: boolean; message: string }> {
    const encoded = encodeURIComponent(message);
    const url = `tg://msg?text=${encoded}`;
    
    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened Telegram with message.` };
    } catch (err) {
      return { success: false, message: `Failed to open Telegram: ${err}` };
    }
  }
}

export const messagingService = new MessagingService();
