import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Using a dot-file for the memory db in the project root
const DB_PATH = path.join(process.cwd(), ".d-ask-memory.db");

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface Memory {
  id: number;
  text: string;
  timestamp: string;
  vector: number[];
  similarity?: number;
}

class MemoryService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        vector TEXT NOT NULL
      );
    `);
  }

  // ── Preferences (Key-Value) ─────────────────────────────────────────────────

  storePreference(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO preferences (key, value)
      VALUES (?, ?)
    `);
    stmt.run(key, value);
  }

  getPreference(key: string): string | null {
    const stmt = this.db.prepare(`
      SELECT value FROM preferences WHERE key = ?
    `);
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  // ── Semantic Memories ───────────────────────────────────────────────────────

  storeMemory(text: string, embedding: number[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (text, vector)
      VALUES (?, ?)
    `);
    stmt.run(text, JSON.stringify(embedding));
  }

  searchMemories(queryEmbedding: number[], limit: number = 5): Memory[] {
    const stmt = this.db.prepare(`
      SELECT id, text, timestamp, vector FROM memories
    `);
    const allMemories = stmt.all() as { id: number; text: string; timestamp: string; vector: string }[];
    
    const memoriesWithSimilarity: Memory[] = allMemories.map(row => {
      const vector = JSON.parse(row.vector) as number[];
      return {
        id: row.id,
        text: row.text,
        timestamp: row.timestamp,
        vector,
        similarity: cosineSimilarity(queryEmbedding, vector)
      };
    });

    // Sort by descending similarity and take top N
    memoriesWithSimilarity.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return memoriesWithSimilarity.slice(0, limit);
  }
}

export const memoryService = new MemoryService();
