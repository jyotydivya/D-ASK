// ─────────────────────────────────────────────────────────────────────────────
// Persistent local memory (replaces the legacy cloud-embedding memory). One SQLite file on this machine
// (%LOCALAPPDATA%\D-ASK\memory.db by default), nothing sent anywhere:
//   - relevance: SQLite FTS5 (BM25, porter stemming) over content and tags, combined with recency, use and pinning;
//     no embedding service (a local embedding model can be added later behind the same recall() contract);
//   - metadata: kind, tags, source (user | agent), sensitivity, created/updated/last-used, expiry;
//   - privacy: secrets (passwords, card numbers, keys, tokens) are refused, never stored; deletions are real
//     (secure_delete on, FTS rows removed with the row); export is the user's view of everything stored;
//   - separation: persistent USER memory lives here; temporary task state never does (TaskScratch is in-memory only).
// Footprint: a few MB for tens of thousands of entries; bounded at MAX_ENTRIES.
// ─────────────────────────────────────────────────────────────────────────────

// Loaded lazily (in the constructor), like Playwright: the packaged agent host ships no node_modules, and it must start
// with memory OFF (the default). Found by the package acceptance run 2026-11-10 (MODULE_NOT_FOUND at host start).
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MemoryKind = "preference" | "fact" | "person" | "project" | "note" | "task_summary";
export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact", "person", "project", "note", "task_summary"];
export type MemorySource = "user" | "agent";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: MemorySource;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  expiresAt: string | null;
}
export interface RecallHit extends MemoryEntry { score: number }

export const MAX_CONTENT_CHARS = 1000;
export const MAX_ENTRIES = 20_000;
export const MAX_TAGS = 8;

export class MemoryRefusedError extends Error {}

/** Content that must never be stored (the user can still keep it elsewhere; D-ASK will not). */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(pass(word|wd|phrase|code)|pin|otp|one[- ]time\s+code|security\s+code|cvv|cvc)\b\s*(is|:|=)?\s*\S+/i, "a password, PIN or security code"],
  [/\b(?:\d[ -]?){13,19}\b/, "a payment card number"],
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "an API key or access token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "a session token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(api[_ -]?key|secret|token|bearer)\b\s*(is|:|=)\s*\S{8,}/i, "a secret or token"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "an identity number"],
];
export function secretIn(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

export function defaultMemoryPath(): string {
  // DASK_MEMORY_DB (set by the daemon's AgentHost:MemoryPath, e.g. an acceptance run's own folder) overrides the default location.
  const override = process.env.DASK_MEMORY_DB;
  if (override && path.isAbsolute(override)) return override;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "D-ASK", "memory.db");
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
const keyOf = (s: string) => normalise(s).toLowerCase().replace(/[.!?]+$/, "");
const STOP = new Set("a an the and or of to in on at for is are was were be been my me i you your it this that what who where when which how do does did about with from as by".split(" "));

/** Query text -> a safe FTS5 expression (terms OR'd, prefix-matched); null when nothing searchable remains. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t)))].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null;
}

interface Row { id: string; kind: MemoryKind; content: string; tags: string; source: MemorySource; pinned: number; created_at: string; updated_at: string; last_used_at: string | null; use_count: number; expires_at: string | null }
const toEntry = (r: Row): MemoryEntry => ({
  id: r.id, kind: r.kind, content: r.content, tags: JSON.parse(r.tags) as string[], source: r.source, pinned: r.pinned === 1,
  createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at, useCount: r.use_count, expiresAt: r.expires_at,
});

export class MemoryStore {
  private readonly db: Database.Database;
  constructor(readonly file: string = defaultMemoryPath(), private readonly now: () => Date = () => new Date()) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Db = require("better-sqlite3") as typeof Database;
    this.db = new Db(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, content_key TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS memories_key ON memories(kind, content_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags); END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags); END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags); END;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(k, v) VALUES ('schema', '1');`);
    this.purgeExpired();
  }

  /** Stores (or refreshes) one memory. Refuses secrets and over-long content; identical content updates the existing one. */
  remember(input: { kind: MemoryKind; content: string; tags?: string[]; source: MemorySource; pinned?: boolean; expiresAt?: Date | null }): { entry: MemoryEntry; created: boolean } {
    const content = normalise(input.content);
    if (!MEMORY_KINDS.includes(input.kind)) throw new MemoryRefusedError(`unknown kind ${input.kind}`);
    if (content.length < 2) throw new MemoryRefusedError("nothing to remember");
    if (content.length > MAX_CONTENT_CHARS) throw new MemoryRefusedError(`a memory is at most ${MAX_CONTENT_CHARS} characters`);
    const secret = secretIn(content);
    if (secret) throw new MemoryRefusedError(`it looks like ${secret}; D-ASK never stores those`);
    const tags = [...new Set((input.tags ?? []).map((t) => normalise(t).toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, MAX_TAGS);
    if (tags.some((t) => secretIn(t))) throw new MemoryRefusedError("a tag looks like a secret");
    const now = this.now().toISOString();
    const key = keyOf(content);
    const existing = this.db.prepare("SELECT * FROM memories WHERE kind = ? AND content_key = ?").get(input.kind, key) as Row | undefined;
    if (existing) {
      const merged = [...new Set([...JSON.parse(existing.tags) as string[], ...tags])].slice(0, MAX_TAGS);
      this.db.prepare("UPDATE memories SET content = ?, tags = ?, updated_at = ?, pinned = MAX(pinned, ?), expires_at = ? WHERE id = ?")
        .run(content, JSON.stringify(merged), now, input.pinned ? 1 : 0, input.expiresAt?.toISOString() ?? existing.expires_at, existing.id);
      return { entry: this.get(existing.id)!, created: false };
    }
    if (this.count() >= MAX_ENTRIES) this.evictOne();
    const id = randomUUID();
    this.db.prepare("INSERT INTO memories(id, kind, content, content_key, tags, source, pinned, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.kind, content, key, JSON.stringify(tags), input.source, input.pinned ? 1 : 0, now, now, input.expiresAt?.toISOString() ?? null);
    return { entry: this.get(id)!, created: true };
  }

  get(id: string): MemoryEntry | null {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return r ? toEntry(r) : null;
  }

  /** Relevance (BM25) blended with pinning, recency and use. Marks the returned entries as used. */
  recall(query: string, opts: { limit?: number; kinds?: MemoryKind[]; tags?: string[]; touch?: boolean } = {}): RecallHit[] {
    this.purgeExpired();
    const q = ftsQuery(query);
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const rows = this.db.prepare(`SELECT m.*, bm25(memories_fts, 1.0, 0.5) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`).all(q) as (Row & { rank: number })[];
    const nowMs = this.now().getTime();
    const hits = rows
      .filter((r) => !opts.kinds?.length || opts.kinds.includes(r.kind))
      .filter((r) => !opts.tags?.length || opts.tags.some((t) => (JSON.parse(r.tags) as string[]).includes(t.toLowerCase())))
      .map((r) => {
        const ageDays = Math.max(0, (nowMs - Date.parse(r.updated_at)) / 86_400_000);
        const relevance = -r.rank; // bm25: lower is better
        const score = relevance * (1 + (r.pinned ? 0.5 : 0) + Math.min(r.use_count, 20) * 0.02) * (1 / (1 + ageDays / 180));
        return { ...toEntry(r), score: Math.round(score * 1000) / 1000 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (opts.touch !== false && hits.length) {
      const now = this.now().toISOString();
      const upd = this.db.prepare("UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?");
      this.db.transaction(() => { for (const h of hits) upd.run(now, h.id); })();
    }
    return hits;
  }

  list(opts: { kinds?: MemoryKind[]; limit?: number; offset?: number } = {}): MemoryEntry[] {
    const kinds = opts.kinds?.length ? opts.kinds : MEMORY_KINDS;
    const rows = this.db.prepare(`SELECT * FROM memories WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`)
      .all(...kinds, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0) as Row[];
    return rows.map(toEntry);
  }

  update(id: string, change: { content?: string; tags?: string[]; pinned?: boolean }): MemoryEntry | null {
    const cur = this.get(id);
    if (!cur) return null;
    const content = change.content !== undefined ? normalise(change.content) : cur.content;
    if (content.length > MAX_CONTENT_CHARS || content.length < 2) throw new MemoryRefusedError("invalid content length");
    const secret = secretIn(content);
    if (secret) throw new MemoryRefusedError(`it looks like ${secret}; D-ASK never stores those`);
    const tags = change.tags ? [...new Set(change.tags.map((t) => normalise(t).toLowerCase()))].slice(0, MAX_TAGS) : cur.tags;
    this.db.prepare("UPDATE memories SET content = ?, content_key = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?")
      .run(content, keyOf(content), JSON.stringify(tags), (change.pinned ?? cur.pinned) ? 1 : 0, this.now().toISOString(), id);
    return this.get(id);
  }

  /** Real deletion (row and index entry; secure_delete overwrites the freed pages). */
  forget(id: string): boolean {
    const ok = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes === 1;
    // The write-ahead log would still hold the deleted text until a checkpoint: checkpoint now so it is really gone.
    if (ok) this.db.pragma("wal_checkpoint(TRUNCATE)");
    return ok;
  }

  /** The entries whose content contains EVERY given word (the user's "forget what you know about X"). Not deleted here. */
  matchingAll(text: string): MemoryEntry[] {
    const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t)))];
    if (!terms.length) return [];
    const q = terms.map((t) => `"${t}"*`).join(" AND ");
    return (this.db.prepare("SELECT m.* FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? LIMIT 100").all(q) as Row[]).map(toEntry);
  }

  /** Everything, for the user (transparency / backup). */
  exportAll(): MemoryEntry[] { return (this.db.prepare("SELECT * FROM memories ORDER BY created_at").all() as Row[]).map(toEntry); }

  forgetAll(): number {
    const n = this.db.prepare("DELETE FROM memories").run().changes;
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild'); VACUUM;");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    return n;
  }

  count(): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n; }

  private purgeExpired() { this.db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?").run(this.now().toISOString()); }
  /** At capacity: drop the least valuable unpinned agent-written entry, else the oldest unpinned one. Never a pinned one. */
  private evictOne() {
    const r = (this.db.prepare("SELECT id FROM memories WHERE pinned = 0 ORDER BY (source = 'user'), use_count, updated_at LIMIT 1").get() as { id: string } | undefined);
    if (!r) throw new MemoryRefusedError("memory is full of pinned entries");
    this.forget(r.id);
  }

  close() { this.db.close(); }
}

/** Temporary, per-task working state. In memory only; never written to disk; dropped when the task ends. */
export class TaskScratch {
  private readonly byTask = new Map<string, Map<string, unknown>>();
  set(taskId: string, key: string, value: unknown) { (this.byTask.get(taskId) ?? this.byTask.set(taskId, new Map()).get(taskId)!).set(key, value); }
  get<T>(taskId: string, key: string): T | undefined { return this.byTask.get(taskId)?.get(key) as T | undefined; }
  end(taskId: string) { this.byTask.delete(taskId); }
  get openTasks(): number { return this.byTask.size; }
}
