import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class WebToolsService {
  public async searchWeb(query: string): Promise<{ success: boolean; message: string }> {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://duckduckgo.com/?q=${encodedQuery}`;
    
    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened web search for: ${query}` };
    } catch (err) {
      return { success: false, message: `Failed to open web search: ${err}` };
    }
  }

  public async checkWeather(location?: string): Promise<{ success: boolean; message: string }> {
    const query = location ? `weather in ${location}` : `weather`;
    const encodedQuery = encodeURIComponent(query);
    const url = `https://duckduckgo.com/?q=${encodedQuery}`;
    
    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened weather for: ${location || 'current location'}` };
    } catch (err) {
      return { success: false, message: `Failed to open weather: ${err}` };
    }
  }
}

export const webToolsService = new WebToolsService();
