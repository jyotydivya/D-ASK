import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class YouTubePlayerService {
  public async searchAndPlay(query: string): Promise<{ success: boolean; message: string }> {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.youtube.com/results?search_query=${encodedQuery}`;
    
    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened YouTube search for: ${query}` };
    } catch (err) {
      return { success: false, message: `Failed to open YouTube: ${err}` };
    }
  }
}

export const youtubePlayerService = new YouTubePlayerService();
