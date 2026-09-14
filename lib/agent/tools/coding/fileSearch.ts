import fs from "fs";
import path from "path";
import readline from "readline";

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
]);

export async function grepSearch(
  rootDir: string,
  query: string,
  isRegex: boolean = false,
  caseInsensitive: boolean = false
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const regexFlags = caseInsensitive ? "i" : "";
  // Escape regex if not isRegex
  const patternStr = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(patternStr, regexFlags);

  async function searchInFile(filePath: string) {
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 1;
    for await (const line of rl) {
      if (regex.test(line)) {
        results.push({
          file: path.relative(rootDir, filePath),
          line: lineNumber,
          content: line.trim(),
        });
        if (results.length >= 100) {
          rl.close();
          break; // Hard cap at 100 results for sanity
        }
      }
      lineNumber++;
    }
  }

  async function walkDir(dir: string) {
    if (results.length >= 100) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= 100) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          await walkDir(fullPath);
        }
      } else if (entry.isFile()) {
        // Skip binary or large files if possible, simple heuristic
        if (
          !entry.name.endsWith(".png") &&
          !entry.name.endsWith(".jpg") &&
          !entry.name.endsWith(".sqlite") &&
          !entry.name.endsWith(".db") &&
          !entry.name.endsWith(".zip") &&
          !entry.name.endsWith(".pdf")
        ) {
          await searchInFile(fullPath);
        }
      }
    }
  }

  await walkDir(rootDir);
  return results;
}
