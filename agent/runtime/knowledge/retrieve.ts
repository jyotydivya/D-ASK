// ─────────────────────────────────────────────────────────────────────────────
// Hybrid retrieval: FTS5 BM25 keyword search + exact cosine search over local embeddings, fused with reciprocal-rank fusion
// (RRF, k=60). A vector-only candidate must reach `minCosine`; keyword candidates must contain a query term. Duplicate chunks are
// merged, at most `perDocument` passages come from one document, and the top `k` are returned with full source references.
// With no embedder (or a failure) retrieval is keyword-only and says so.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { ftsQuery } from "../memory/memoryStore";
import type { Embedder } from "./embedder";
import type { ChunkRow, DocumentRow, KnowledgeStore } from "./store";

export interface RetrieveOptions { k: number; perDocument: number; minCosine: number; candidates: number; excludeSections?: RegExp }
export const DEFAULT_RETRIEVAL: RetrieveOptions = Object.freeze({ k: 6, perDocument: 3, minCosine: 0.6, candidates: 40 });
export const REFERENCE_SECTIONS = /^(references|bibliography|acknowledg)/i;

export interface Passage {
  /** 1-based citation number within one answer. */
  n: number;
  chunk: ChunkRow;
  doc: DocumentRow;
  score: number;
  cosine: number | null;
  keyword: boolean;
}
export interface Retrieval { passages: Passage[]; mode: "hybrid" | "keyword" | "vector" | "none"; note: string | null }

export async function retrieve(store: KnowledgeStore, embedder: Embedder | null, query: string, collections: string[], opts: Partial<RetrieveOptions> = {}, signal?: AbortSignal): Promise<Retrieval> {
  const o = { ...DEFAULT_RETRIEVAL, ...opts };
  const fts = ftsQuery(query);
  const kw = fts ? store.keywordSearch(fts, collections, o.candidates) : [];
  let vec: { rowid: number; cosine: number }[] = [];
  let note: string | null = null;
  if (embedder) {
    try {
      const [q] = await embedder.embed([query], "query", signal);
      vec = store.vectorSearch(q!, collections, o.candidates);
    } catch (e) {
      if (signal?.aborted) throw e;
      note = `semantic search unavailable (${e instanceof Error ? e.message : e}); keyword search only`;
    }
  } else note = "no local embedding model; keyword search only";

  const fused = new Map<number, { score: number; cosine: number | null; keyword: boolean }>();
  kw.forEach((h, i) => fused.set(h.rowid, { score: 1 / (60 + i + 1), cosine: null, keyword: true }));
  vec.forEach((h, i) => {
    const cur = fused.get(h.rowid);
    if (cur) { cur.score += 1 / (60 + i + 1); cur.cosine = h.cosine; }
    else if (h.cosine >= o.minCosine) fused.set(h.rowid, { score: 1 / (60 + i + 1), cosine: h.cosine, keyword: false });
  });
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
  const rows = new Map(store.chunksByRowid(ranked.map(([r]) => r)).map((c) => [c.rowid, c]));
  const docs = new Map<string, DocumentRow | null>();
  const perDoc = new Map<string, number>();
  const seenText = new Set<string>();
  const passages: Passage[] = [];
  for (const [rowid, s] of ranked) {
    const chunk = rows.get(rowid);
    if (!chunk) continue;
    if (o.excludeSections && o.excludeSections.test(chunk.heading.replace(/^[\dIVX.]+\s*/, ""))) continue;
    const key = chunk.text.slice(0, 200);
    if (seenText.has(key)) continue;
    if ((perDoc.get(chunk.docId) ?? 0) >= o.perDocument) continue;
    if (!docs.has(chunk.docId)) docs.set(chunk.docId, store.documentById(chunk.docId));
    const doc = docs.get(chunk.docId);
    if (!doc) continue;
    seenText.add(key);
    perDoc.set(chunk.docId, (perDoc.get(chunk.docId) ?? 0) + 1);
    passages.push({ n: passages.length + 1, chunk, doc, score: s.score, cosine: s.cosine, keyword: s.keyword });
    if (passages.length >= o.k) break;
  }
  const mode = passages.length === 0 ? "none" : kw.length && vec.length ? "hybrid" : vec.length ? "vector" : "keyword";
  return { passages, mode, note };
}

/** "Title (file.pdf, p. 3, § 3.2 Method)" or, for code, "src/x.ts:10-42 (functionName)". */
export function citation(p: Pick<Passage, "chunk" | "doc">): string {
  const { chunk, doc } = p;
  // A web page (optional online source): cited by its address, never by a file name.
  if (/^https?:\/\//i.test(doc.path)) return `${doc.title && doc.title !== doc.path ? `${doc.title.slice(0, 120)} ` : ""}(${doc.path}${chunk.heading ? `, § ${chunk.heading.slice(0, 80)}` : ""}; web page)`;
  const file = path.basename(doc.path);
  if (doc.format === "code") return `${doc.path}${chunk.lineStart ? `:${chunk.lineStart}-${chunk.lineEnd ?? chunk.lineStart}` : ""}${chunk.symbol ? ` (${chunk.symbol})` : ""}`;
  const parts = [file];
  if (chunk.page) parts.push(chunk.pageEnd && chunk.pageEnd !== chunk.page ? `pp. ${chunk.page}-${chunk.pageEnd}` : `p. ${chunk.page}`);
  else if (chunk.lineStart && doc.format !== "docx") parts.push(`lines ${chunk.lineStart}-${chunk.lineEnd ?? chunk.lineStart}`);
  if (chunk.heading) parts.push(`§ ${chunk.heading.slice(0, 80)}`);
  const title = doc.title && doc.title !== file ? `${doc.title.slice(0, 120)} ` : "";
  return `${title}(${parts.join(", ")})`;
}

const STOP = new Set("a an the and or of to in on at for is are was were be been by with from as that this these those it its into than then which what who how why when where does do did can could would should may might will shall not no our we they their them there here also such using use used based".split(" "));
export function contentTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []).filter((t) => !STOP.has(t)))];
}
