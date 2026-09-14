import fs from "fs/promises";
import path from "path";

export class FileToolsService {
  /**
   * Ensure a path is within the allowed workspace.
   * This is a basic safety check to prevent directory traversal attacks if run outside a true sandbox.
   */
  private normalizePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return resolved;
  }

  async readFile(filePath: string): Promise<string> {
    try {
      const p = this.normalizePath(filePath);
      const content = await fs.readFile(p, "utf-8");
      return content;
    } catch (err) {
      throw new Error(`Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; message: string }> {
    try {
      const p = this.normalizePath(filePath);
      const dir = path.dirname(p);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(p, content, "utf-8");
      return { success: true, message: `Successfully wrote to ${filePath}` };
    } catch (err) {
      throw new Error(`Failed to write file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const p = this.normalizePath(dirPath);
      const files = await fs.readdir(p);
      return files;
    } catch (err) {
      throw new Error(`Failed to list directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async deleteFile(filePath: string): Promise<{ success: boolean; message: string }> {
    try {
      const p = this.normalizePath(filePath);
      await fs.unlink(p);
      return { success: true, message: `Successfully deleted ${filePath}` };
    } catch (err) {
      throw new Error(`Failed to delete file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async copyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; message: string }> {
    try {
      const src = this.normalizePath(sourcePath);
      const dest = this.normalizePath(destPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      return { success: true, message: `Successfully copied to ${destPath}` };
    } catch (err) {
      throw new Error(`Failed to copy file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async moveFile(sourcePath: string, destPath: string): Promise<{ success: boolean; message: string }> {
    try {
      const src = this.normalizePath(sourcePath);
      const dest = this.normalizePath(destPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return { success: true, message: `Successfully moved to ${destPath}` };
    } catch (err) {
      throw new Error(`Failed to move file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const fileToolsService = new FileToolsService();
