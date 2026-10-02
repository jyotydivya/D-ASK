// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Enhanced Memory Service — Category-based memory with recall & summaries
// Ported from Mark-LV memory/memory_manager.py — adds structured categories,
// keyword search, session summaries, and prompt budgeting.
// ─────────────────────────────────────────────────────────────────────────────

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), ".d-ask-memory.db");

// ── Memory Categories (from Mark-LV) ─────────────────────────────────────────
export type MemoryCategory =
  | "identity"      // User's name, role, preferences
  | "preferences"   // Liked/disliked things, settings
  | "projects"      // Current projects, work context
  | "relationships" // People the user mentions
  | "wishes"        // Things user wants to do/try
  | "notes"         // General facts and learnings
  | "session";      // Session summaries

export interface Memory {
  id: number;
  text: string;
  category: MemoryCategory;
  timestamp: string;
  vector: number[];
  similarity?: number;
}

export interface SessionSummary {
  id: number;
  sessionId: string;
  summary: string;
  taskCount: number;
  timestamp: string;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
        category TEXT NOT NULL DEFAULT 'notes',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        vector TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add category column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'notes';`);
    } catch {
      // Column already exists
    }
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

  getAllPreferences(): Record<string, string> {
    const stmt = this.db.prepare(`SELECT key, value FROM preferences`);
    const rows = stmt.all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ── Semantic Memories (with categories) ─────────────────────────────────────

  storeMemory(text: string, embedding: number[], category: MemoryCategory = "notes"): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (text, category, vector)
      VALUES (?, ?, ?)
    `);
    stmt.run(text, category, JSON.stringify(embedding));
  }

  searchMemories(queryEmbedding: number[], limit: number = 5, category?: MemoryCategory): Memory[] {
    let stmt;
    if (category) {
      stmt = this.db.prepare(`SELECT id, text, category, timestamp, vector FROM memories WHERE category = ?`);
    } else {
      stmt = this.db.prepare(`SELECT id, text, category, timestamp, vector FROM memories`);
    }

    const allMemories = (category ? stmt.all(category) : stmt.all()) as {
      id: number; text: string; category: string; timestamp: string; vector: string;
    }[];

    const memoriesWithSimilarity: Memory[] = allMemories.map(row => {
      const vector = JSON.parse(row.vector) as number[];
      return {
        id: row.id,
        text: row.text,
        category: row.category as MemoryCategory,
        timestamp: row.timestamp,
        vector,
        similarity: cosineSimilarity(queryEmbedding, vector),
      };
    });

    memoriesWithSimilarity.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return memoriesWithSimilarity.slice(0, limit);
  }

  /**
   * Keyword-based memory search (no embeddings needed).
   * Useful as a fast fallback when we don't have an embedding model.
   */
  searchByKeyword(query: string, limit: number = 10, category?: MemoryCategory): Memory[] {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    let stmt;
    if (category) {
      stmt = this.db.prepare(`SELECT id, text, category, timestamp, vector FROM memories WHERE category = ?`);
    } else {
      stmt = this.db.prepare(`SELECT id, text, category, timestamp, vector FROM memories`);
    }

    const allMemories = (category ? stmt.all(category) : stmt.all()) as {
      id: number; text: string; category: string; timestamp: string; vector: string;
    }[];

    // Score by keyword matches
    const scored = allMemories.map(row => {
      const lower = row.text.toLowerCase();
      const score = words.reduce((acc, word) => acc + (lower.includes(word) ? 1 : 0), 0);
      return { ...row, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter(r => r.score > 0)
      .slice(0, limit)
      .map(row => ({
        id: row.id,
        text: row.text,
        category: row.category as MemoryCategory,
        timestamp: row.timestamp,
        vector: JSON.parse(row.vector),
        similarity: row.score,
      }));
  }

  /**
   * Get all memories in a category.
   */
  getByCategory(category: MemoryCategory, limit: number = 20): Memory[] {
    const stmt = this.db.prepare(`
      SELECT id, text, category, timestamp, vector
      FROM memories WHERE category = ?
      ORDER BY timestamp DESC LIMIT ?
    `);
    const rows = stmt.all(category, limit) as {
      id: number; text: string; category: string; timestamp: string; vector: string;
    }[];

    return rows.map(row => ({
      id: row.id,
      text: row.text,
      category: row.category as MemoryCategory,
      timestamp: row.timestamp,
      vector: JSON.parse(row.vector),
    }));
  }

  /**
   * Delete a specific memory.
   */
  deleteMemory(id: number): boolean {
    const stmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get total memory count.
   */
  getMemoryCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM memories`);
    return (stmt.get() as { count: number }).count;
  }

  // ── Session Summaries ───────────────────────────────────────────────────────

  storeSessionSummary(sessionId: string, summary: string, taskCount: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (session_id, summary, task_count)
      VALUES (?, ?, ?)
    `);
    stmt.run(sessionId, summary, taskCount);
  }

  getSessionSummaries(limit: number = 5): SessionSummary[] {
    const stmt = this.db.prepare(`
      SELECT id, session_id, summary, task_count, timestamp
      FROM session_summaries
      ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit) as SessionSummary[];
  }

  // ── Conversation History ───────────────────────────────────────────────────

  addConversationTurn(sessionId: string, role: "user" | "assistant", content: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_history (session_id, role, content)
      VALUES (?, ?, ?)
    `);
    stmt.run(sessionId, role, content);
  }

  getConversationHistory(sessionId: string, limit: number = 20): { role: string; content: string; timestamp: string }[] {
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp
      FROM conversation_history
      WHERE session_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `);
    return (stmt.all(sessionId, limit) as any[]).reverse();
  }

  // ── Prompt Budget Helper ─────────────────────────────────────────────────────
  // Fits relevant memories into a token budget for context injection.

  buildMemoryContext(query: string, maxChars: number = 2000): string {
    const parts: string[] = [];
    let budget = maxChars;

    // 1. Identity memories (always include)
    const identity = this.getByCategory("identity", 5);
    for (const mem of identity) {
      if (budget <= 0) break;
      const line = `[Identity] ${mem.text}`;
      if (line.length <= budget) {
        parts.push(line);
        budget -= line.length;
      }
    }

    // 2. Preferences (include top 5)
    const prefs = this.getByCategory("preferences", 5);
    for (const mem of prefs) {
      if (budget <= 0) break;
      const line = `[Preference] ${mem.text}`;
      if (line.length <= budget) {
        parts.push(line);
        budget -= line.length;
      }
    }

    // 3. Keyword-matched memories from query
    const relevant = this.searchByKeyword(query, 5);
    for (const mem of relevant) {
      if (budget <= 0) break;
      const line = `[${mem.category}] ${mem.text}`;
      if (line.length <= budget && !parts.includes(line)) {
        parts.push(line);
        budget -= line.length;
      }
    }

    // 4. Recent session summaries
    const summaries = this.getSessionSummaries(2);
    for (const s of summaries) {
      if (budget <= 0) break;
      const line = `[Session] ${s.summary}`;
      if (line.length <= budget) {
        parts.push(line);
        budget -= line.length;
      }
    }

    return parts.length > 0
      ? `--- User Memory ---\n${parts.join("\n")}\n---`
      : "";
  }
}

export const memoryService = new MemoryService();
