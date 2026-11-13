// ─────────────────────────────────────────────────────────────────────────────
// Incremental indexing of a collection's folders. Read-only on the user's files.
//   - Folders must resolve (canonically, links followed) inside the allowed knowledge roots; anything else is refused.
//   - Hidden/dependency folders, secret-looking names and (for code collections) build output, binaries and generated files are
//     never read. Symbolic links and junctions are not followed during the walk.
//   - Unchanged files (same size and mtime, or same SHA-256) are not re-processed; changed files are replaced atomically; files
//     that disappeared are removed from the index (only after a COMPLETE walk).
//   - Unreadable or malformed files are recorded with the reason and never stop the run.
//   - Cancellation (task cancel or Emergency Stop) is checked between files and inside embedding requests.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isHiddenDir, isSecretName, relativeInside, type FileRoot } from "../tools/fileAccess";
import { chunkDocument } from "./chunk";
import type { Embedder } from "./embedder";
import { formatOf, parseDocument, UnreadableError } from "./extract";
import type { CollectionKind, KnowledgeStore } from "./store";

export const INDEX_LIMITS = Object.freeze({ maxFilesPerRun: 5000, maxDepth: 14, maxTextBytes: 2 * 1024 * 1024, maxBinaryDocBytes: 40 * 1024 * 1024 });

const CODE_SKIP_DIRS = new Set(["dist", "build", "out", "bin", "obj", "target", "coverage", ".next", "results", "scratch", "work", "models", "local-inference", "vendor", "third_party", "generated", "__generated__", "tsconfig.tsbuildinfo"]);
const CODE_SKIP_FILES = /(^package-lock\.json$|^pnpm-lock\.yaml$|^yarn\.lock$|\.min\.(js|css)$|\.map$|\.d\.ts$|\.designer\.cs$|\.g\.cs$|^next-env\.d\.ts$)/i;

export interface IndexProgress { seen: number; indexed: number; unchanged: number; failed: number; current?: string }
export interface IndexReport extends IndexProgress {
  collection: string;
  removed: number;
  keywordOnly: number;
  status: "completed" | "cancelled" | "failed";
  stoppedAtLimit: boolean;
  failures: { path: string; reason: string }[];
  embeddingNote: string | null;
}

export const docIdOf = (collection: string, file: string) => createHash("sha256").update(`${collection.toLowerCase()}\u0000${file.toLowerCase()}`).digest("hex").slice(0, 20);

/** Canonical folder inside an allowed root, or the reason it is refused. */
export async function resolveIndexFolder(roots: readonly FileRoot[], input: string): Promise<{ ok: true; folder: string } | { ok: false; reason: string }> {
  if (!path.isAbsolute(input)) return { ok: false, reason: "give the folder's full path (for example D:\\Papers)" };
  if (/^\\\\|^\\\\\?\\|:.*:/.test(input)) return { ok: false, reason: "network, device and stream paths are not indexed" };
  let real: string;
  try { real = await fsp.realpath(input); } catch { return { ok: false, reason: "that folder does not exist" }; }
  try { if (!(await fsp.stat(real)).isDirectory()) return { ok: false, reason: "that is a file, not a folder" }; } catch { return { ok: false, reason: "that folder cannot be read" }; }
  const inside = roots.find((r) => relativeInside(r.path, real) !== null);
  if (!inside) return { ok: false, reason: `it is outside the folders D-ASK may read (${roots.map((r) => r.path).join("; ")}). Add it to DASK_KNOWLEDGE_ROOTS in %LOCALAPPDATA%\\D-ASK\\features.cmd to allow it` };
  const rel = relativeInside(inside.path, real)!;
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) if (isHiddenDir(seg) || isSecretName(seg)) return { ok: false, reason: `"${seg}" is a hidden or private folder` };
  return { ok: true, folder: real };
}

async function* walkFiles(folder: string, kind: CollectionKind, signal: AbortSignal, depth = 0): AsyncGenerator<string> {
  if (depth > INDEX_LIMITS.maxDepth || signal.aborted) return;
  let entries: import("node:fs").Dirent[];
  try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (signal.aborted) return;
    if (e.isSymbolicLink()) continue;
    const full = path.join(folder, e.name);
    if (e.isDirectory()) {
      if (isHiddenDir(e.name) || e.name.startsWith(".") || isSecretName(e.name)) continue;
      if (kind === "code" && CODE_SKIP_DIRS.has(e.name.toLowerCase())) continue;
      yield* walkFiles(full, kind, signal, depth + 1);
    } else if (e.isFile()) {
      if (isSecretName(e.name) || e.name.startsWith("~$")) continue;
      const fmt = formatOf(e.name);
      if (!fmt) continue;
      if (kind === "code" && CODE_SKIP_FILES.test(e.name)) continue;
      yield full;
    }
  }
}

export interface IndexDeps { store: KnowledgeStore; embedder: Embedder | null; log?: (m: string) => void }

export async function indexCollection(deps: IndexDeps, collection: string, kind: CollectionKind, folders: string[], signal: AbortSignal, onProgress?: (p: IndexProgress) => void): Promise<IndexReport> {
  const { store } = deps;
  let embedder = deps.embedder;
  let embeddingNote: string | null = embedder ? null : "no local embedding model is available; documents are searchable by keyword only";
  if (embedder) store.bindEmbeddingModel(embedder.modelId);
  const runId = store.startRun(collection);
  const r: IndexReport = { collection, seen: 0, indexed: 0, unchanged: 0, failed: 0, removed: 0, keywordOnly: 0, status: "completed", stoppedAtLimit: false, failures: [], embeddingNote };
  const seen = new Set<string>();
  let lastEmit = 0;
  const progress = (current?: string) => { const t = Date.now(); if (onProgress && t - lastEmit > 500) { lastEmit = t; try { onProgress({ seen: r.seen, indexed: r.indexed, unchanged: r.unchanged, failed: r.failed, current }); } catch { /* observers never break indexing */ } } };
  try {
    outer: for (const folder of folders) {
      for await (const file of walkFiles(folder, kind, signal)) {
        if (signal.aborted) break outer;
        if (r.seen >= INDEX_LIMITS.maxFilesPerRun) { r.stoppedAtLimit = true; break outer; }
        r.seen++;
        seen.add(file.toLowerCase());
        progress(path.basename(file));
        try {
          const st = await fsp.stat(file);
          const fmt = formatOf(file)!;
          const limit = fmt === "pdf" || fmt === "docx" ? INDEX_LIMITS.maxBinaryDocBytes : INDEX_LIMITS.maxTextBytes;
          const prev = store.document(collection, file);
          const needsVectors = prev?.status === "keyword-only" && embedder !== null;
          if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 1 && !needsVectors) { r.unchanged++; continue; }
          if (st.size > limit) throw new UnreadableError(`larger than ${Math.round(limit / 1048576)} MB`);
          const buf = await fsp.readFile(file);
          const sha = createHash("sha256").update(buf).digest("hex");
          if (prev && prev.sha256 === sha && !needsVectors) { store.touchDocument(prev.id, st.mtimeMs); r.unchanged++; continue; }
          const id = docIdOf(collection, file);
          let parsed;
          try { parsed = parseDocument(file, buf); }
          catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            store.replaceDocument({ id, collection, path: file, title: path.basename(file), format: fmt, size: st.size, mtimeMs: st.mtimeMs, sha256: sha, pages: null, status: "unreadable", error: reason.slice(0, 200) }, [], null);
            r.failed++; r.failures.push({ path: file, reason }); continue;
          }
          const chunks = chunkDocument(id, parsed);
          let vectors: (Float32Array | null)[] | null = null;
          if (embedder) {
            try {
              // The heading and title travel with the text into the vector, so a chunk keeps its context.
              vectors = await embedder.embed(chunks.map((c) => `${parsed.title}${c.heading ? " — " + c.heading : ""}\n${c.text}`), "document", signal);
            } catch (e) {
              if (signal.aborted) break outer;
              embeddingNote = `local embeddings stopped working (${e instanceof Error ? e.message : e}); the remaining documents are searchable by keyword only`;
              deps.log?.(`knowledge: ${embeddingNote}`);
              embedder = null; vectors = null;
            }
          }
          if (signal.aborted) break outer;
          store.replaceDocument({ id, collection, path: file, title: parsed.title.slice(0, 300), format: parsed.format, size: st.size, mtimeMs: st.mtimeMs, sha256: sha, pages: parsed.pages, status: vectors ? "indexed" : "keyword-only", error: null }, chunks, vectors);
          r.indexed++;
          if (!vectors) r.keywordOnly++;
        } catch (e) {
          if (signal.aborted) break outer;
          const reason = e instanceof Error ? e.message : String(e);
          r.failed++; r.failures.push({ path: file, reason });
        }
      }
    }
    if (signal.aborted) r.status = "cancelled";
    else if (!r.stoppedAtLimit) {
      // Files that disappeared from the indexed folders are removed from the index.
      for (const d of store.documents(collection)) {
        const under = folders.some((f) => relativeInside(f, d.path) !== null);
        if (under && !seen.has(d.path.toLowerCase())) { store.deleteDocument(d.id); r.removed++; }
      }
      store.touchCollection(collection);
    }
  } catch (e) {
    r.status = "failed";
    r.failures.push({ path: "", reason: e instanceof Error ? e.message : String(e) });
  } finally {
    r.embeddingNote = embeddingNote;
    store.finishRun(runId, { status: r.status, seen: r.seen, indexed: r.indexed, unchanged: r.unchanged, failed: r.failed, removed: r.removed, note: embeddingNote });
  }
  return r;
}
