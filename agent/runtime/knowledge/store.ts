// ─────────────────────────────────────────────────────────────────────────────
// Persistent knowledge index: ONE SQLite file (%LOCALAPPDATA%\D-ASK\knowledge.db by default), separate from the conversational
// memory database, which it never opens.
//   collections  named sets of folders (kind: personal | research | code | folder)
//   documents    one row per indexed file: path, size, mtime, SHA-256, status, chunk count
//   chunks       text + heading/page/line/symbol + an int8-quantised unit vector (384 bytes) or NULL (keyword-only)
//   chunks_fts   FTS5 (BM25, porter) over chunk text and heading, kept in sync by triggers
//   index_runs   every indexing run; a run left "running" by a crash is marked "interrupted" at the next start
// A document and all its chunks are replaced in ONE transaction, so an interrupted run never leaves half a document.
// The embedding model id is recorded; vectors from another model are dropped rather than compared.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Chunk } from "./chunk";
import type { DocFormat } from "./extract";

/** "web": pages the user named, read online (optional); their path is the URL and they have no folders. */
export type CollectionKind = "personal" | "research" | "code" | "folder" | "web";
export interface Collection { name: string; kind: CollectionKind; roots: string[]; createdAt: string; lastIndexedAt: string | null; documents: number; chunks: number; embedded: number; unreadable: number }
export interface DocumentRow { id: string; collection: string; path: string; title: string; format: DocFormat; size: number; mtimeMs: number; sha256: string; pages: number | null; status: "indexed" | "keyword-only" | "unreadable"; error: string | null; chunkCount: number; indexedAt: string }
export interface ChunkRow { rowid: number; id: string; docId: string; collection: string; ordinal: number; heading: string; page: number | null; pageEnd: number | null; lineStart: number | null; lineEnd: number | null; symbol: string | null; text: string }
export interface IndexRun { id: number; collection: string; startedAt: string; finishedAt: string | null; status: "running" | "completed" | "cancelled" | "failed" | "interrupted"; seen: number; indexed: number; unchanged: number; failed: number; removed: number; note: string | null }

export function defaultKnowledgePath(): string {
  const o = process.env.DASK_KNOWLEDGE_DB;
  if (o && path.isAbsolute(o)) return o;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "D-ASK", "knowledge.db");
}

export function quantize(v: Float32Array): Buffer {
  const b = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) b.writeInt8(Math.max(-127, Math.min(127, Math.round(v[i]! * 127))), i);
  return b;
}

export class KnowledgeStore {
  readonly db: Database.Database;
  readonly interruptedRuns: number;
  constructor(readonly file: string = defaultKnowledgePath(), private readonly now: () => Date = () => new Date()) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Db = require("better-sqlite3") as typeof Database;
    this.db = new Db(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("secure_delete = ON");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, kind TEXT NOT NULL, roots TEXT NOT NULL, created_at TEXT NOT NULL, last_indexed_at TEXT);
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE, path TEXT NOT NULL, title TEXT NOT NULL, format TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms REAL NOT NULL, sha256 TEXT NOT NULL, pages INTEGER, status TEXT NOT NULL, error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL, UNIQUE(collection, path));
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, collection TEXT NOT NULL,
        ordinal INTEGER NOT NULL, heading TEXT NOT NULL, page INTEGER, page_end INTEGER, line_start INTEGER, line_end INTEGER, symbol TEXT, text TEXT NOT NULL, embedding BLOB);
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
      CREATE INDEX IF NOT EXISTS chunks_coll ON chunks(collection);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, heading, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.rowid, new.text, new.heading); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.rowid, old.text, old.heading); END;
      CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, note TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(k, v) VALUES ('schema', '1');`);
    this.interruptedRuns = this.db.prepare("UPDATE index_runs SET status='interrupted', finished_at=? WHERE status='running'").run(this.now().toISOString()).changes;
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  // ── Embedding model bookkeeping ──
  /** Records the embedding model; if it changed, every stored vector is dropped (documents become keyword-only until re-indexed). */
  bindEmbeddingModel(modelId: string): boolean {
    const cur = (this.db.prepare("SELECT v FROM meta WHERE k='embed_model'").get() as { v: string } | undefined)?.v;
    if (cur === modelId) return false;
    this.db.transaction(() => {
      if (cur) { this.db.exec("UPDATE chunks SET embedding = NULL"); this.db.exec("UPDATE documents SET status='keyword-only' WHERE status='indexed'"); }
      this.db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('embed_model', ?)").run(modelId);
    })();
    return cur !== undefined;
  }

  // ── Collections ──
  upsertCollection(name: string, kind: CollectionKind, roots: string[]): Collection {
    const existing = this.collection(name);
    const merged = existing ? [...new Set([...existing.roots, ...roots])] : roots;
    if (existing) this.db.prepare("UPDATE collections SET roots=? WHERE name=?").run(JSON.stringify(merged), name);
    else this.db.prepare("INSERT INTO collections(name, kind, roots, created_at) VALUES (?, ?, ?, ?)").run(name, kind, JSON.stringify(merged), this.now().toISOString());
    return this.collection(name)!;
  }
  collection(name: string): Collection | null { return this.collections().find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null; }
  collections(): Collection[] {
    const rows = this.db.prepare(`SELECT c.name, c.kind, c.roots, c.created_at, c.last_indexed_at,
        (SELECT COUNT(*) FROM documents d WHERE d.collection=c.name) docs,
        (SELECT COUNT(*) FROM documents d WHERE d.collection=c.name AND d.status='unreadable') bad,
        (SELECT COUNT(*) FROM chunks k WHERE k.collection=c.name) chunks,
        (SELECT COUNT(*) FROM chunks k WHERE k.collection=c.name AND k.embedding IS NOT NULL) emb
      FROM collections c ORDER BY c.name`).all() as { name: string; kind: CollectionKind; roots: string; created_at: string; last_indexed_at: string | null; docs: number; bad: number; chunks: number; emb: number }[];
    return rows.map((r) => ({ name: r.name, kind: r.kind, roots: JSON.parse(r.roots) as string[], createdAt: r.created_at, lastIndexedAt: r.last_indexed_at, documents: r.docs, chunks: r.chunks, embedded: r.emb, unreadable: r.bad }));
  }
  /** Removes a collection and everything indexed for it (never the user's files). */
  deleteCollection(name: string): boolean {
    const c = this.collection(name);
    if (!c) return false;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM chunks WHERE collection=?").run(c.name);
      this.db.prepare("DELETE FROM documents WHERE collection=?").run(c.name);
      this.db.prepare("DELETE FROM collections WHERE name=?").run(c.name);
    })();
    return true;
  }
  touchCollection(name: string): void { this.db.prepare("UPDATE collections SET last_indexed_at=? WHERE name=?").run(this.now().toISOString(), name); }

  // ── Documents ──
  document(collection: string, file: string): DocumentRow | null {
    const r = this.db.prepare("SELECT * FROM documents WHERE collection=? AND path=?").get(collection, file) as Record<string, unknown> | undefined;
    return r ? toDoc(r) : null;
  }
  documentById(id: string): DocumentRow | null { const r = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as Record<string, unknown> | undefined; return r ? toDoc(r) : null; }
  documents(collection: string): DocumentRow[] { return (this.db.prepare("SELECT * FROM documents WHERE collection=? ORDER BY path").all(collection) as Record<string, unknown>[]).map(toDoc); }
  documentsByPath(file: string): DocumentRow[] { return (this.db.prepare("SELECT * FROM documents WHERE lower(path)=lower(?)").all(file) as Record<string, unknown>[]).map(toDoc); }
  touchDocument(id: string, mtimeMs: number): void { this.db.prepare("UPDATE documents SET mtime_ms=? WHERE id=?").run(mtimeMs, id); }
  deleteDocument(id: string): void { this.db.transaction(() => { this.db.prepare("DELETE FROM chunks WHERE doc_id=?").run(id); this.db.prepare("DELETE FROM documents WHERE id=?").run(id); })(); }

  /** Replaces a document and all its chunks atomically. `vectors[i]` belongs to `chunks[i]` (null: keyword-only). */
  replaceDocument(doc: Omit<DocumentRow, "chunkCount" | "indexedAt">, chunks: Chunk[], vectors: (Float32Array | null)[] | null): void {
    const insertChunk = this.db.prepare(`INSERT INTO chunks(id, doc_id, collection, ordinal, heading, page, page_end, line_start, line_end, symbol, text, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM chunks WHERE doc_id=?").run(doc.id);
      this.db.prepare(`INSERT INTO documents(id, collection, path, title, format, size, mtime_ms, sha256, pages, status, error, chunk_count, indexed_at)
        VALUES (@id, @collection, @path, @title, @format, @size, @mtimeMs, @sha256, @pages, @status, @error, @chunkCount, @indexedAt)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, format=excluded.format, size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256, pages=excluded.pages,
          status=excluded.status, error=excluded.error, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at`)
        .run({ ...doc, chunkCount: chunks.length, indexedAt: this.now().toISOString() });
      chunks.forEach((c, i) => {
        const v = vectors?.[i] ?? null;
        insertChunk.run(c.id, doc.id, doc.collection, c.ordinal, c.heading, c.page, c.pageEnd, c.lineStart, c.lineEnd, c.symbol, c.text, v ? quantize(v) : null);
      });
    })();
  }

  // ── Retrieval primitives ──
  keywordSearch(fts: string, collections: string[], limit: number): { rowid: number; bm25: number }[] {
    if (!collections.length) return [];
    const ph = collections.map(() => "?").join(",");
    return this.db.prepare(`SELECT c.rowid AS rowid, bm25(chunks_fts, 1.0, 0.5) AS bm25 FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ? AND c.collection IN (${ph}) ORDER BY bm25 LIMIT ?`).all(fts, ...collections, limit) as { rowid: number; bm25: number }[];
  }
  /** Exact cosine search over the int8 vectors of the given collections (a few ms per thousand chunks; no index server). */
  vectorSearch(q: Float32Array, collections: string[], limit: number): { rowid: number; cosine: number }[] {
    if (!collections.length) return [];
    const ph = collections.map(() => "?").join(",");
    const top: { rowid: number; cosine: number }[] = [];
    let floor = -Infinity;
    for (const r of this.db.prepare(`SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL AND collection IN (${ph})`).iterate(...collections) as Iterable<{ rowid: number; embedding: Buffer }>) {
      const e = r.embedding;
      if (e.length !== q.length) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i]! * e.readInt8(i);
      const cosine = dot / 127;
      if (top.length < limit || cosine > floor) {
        top.push({ rowid: r.rowid, cosine });
        if (top.length > limit) { top.sort((a, b) => b.cosine - a.cosine); top.length = limit; floor = top[limit - 1]!.cosine; }
      }
    }
    return top.sort((a, b) => b.cosine - a.cosine);
  }
  chunksByRowid(rowids: number[]): ChunkRow[] {
    if (!rowids.length) return [];
    const rows = this.db.prepare(`SELECT rowid, id, doc_id, collection, ordinal, heading, page, page_end, line_start, line_end, symbol, text FROM chunks WHERE rowid IN (${rowids.map(() => "?").join(",")})`).all(...rowids) as Record<string, unknown>[];
    return rows.map((r) => ({ rowid: r.rowid as number, id: r.id as string, docId: r.doc_id as string, collection: r.collection as string, ordinal: r.ordinal as number, heading: r.heading as string, page: r.page as number | null, pageEnd: r.page_end as number | null, lineStart: r.line_start as number | null, lineEnd: r.line_end as number | null, symbol: r.symbol as string | null, text: r.text as string }));
  }

  // ── Runs ──
  startRun(collection: string): number { return Number(this.db.prepare("INSERT INTO index_runs(collection, started_at, status) VALUES (?, ?, 'running')").run(collection, this.now().toISOString()).lastInsertRowid); }
  finishRun(id: number, r: Pick<IndexRun, "status" | "seen" | "indexed" | "unchanged" | "failed" | "removed" | "note">): void {
    this.db.prepare("UPDATE index_runs SET status=?, finished_at=?, seen=?, indexed=?, unchanged=?, failed=?, removed=?, note=? WHERE id=?").run(r.status, this.now().toISOString(), r.seen, r.indexed, r.unchanged, r.failed, r.removed, r.note, id);
  }
  lastRun(collection: string): IndexRun | null {
    const r = this.db.prepare("SELECT * FROM index_runs WHERE collection=? ORDER BY id DESC LIMIT 1").get(collection) as Record<string, unknown> | undefined;
    return r ? { id: r.id as number, collection: r.collection as string, startedAt: r.started_at as string, finishedAt: r.finished_at as string | null, status: r.status as IndexRun["status"], seen: r.seen as number, indexed: r.indexed as number, unchanged: r.unchanged as number, failed: r.failed as number, removed: r.removed as number, note: r.note as string | null } : null;
  }
}

function toDoc(r: Record<string, unknown>): DocumentRow {
  return { id: r.id as string, collection: r.collection as string, path: r.path as string, title: r.title as string, format: r.format as DocFormat, size: r.size as number, mtimeMs: r.mtime_ms as number, sha256: r.sha256 as string, pages: r.pages as number | null, status: r.status as DocumentRow["status"], error: r.error as string | null, chunkCount: r.chunk_count as number, indexedAt: r.indexed_at as string };
}
