// Structure-aware chunking. Blocks are packed into chunks WITHIN one section (heading path) and, for PDFs, one page run; a chunk
// never spans two headings or two code symbols. Oversized blocks are split at sentence (or line, for code) boundaries. Consecutive
// chunks of the same section overlap by the trailing sentence(s) of the previous chunk, up to `overlapChars`.
// Ids are stable: the same document text always gives the same chunk ids.

import { createHash } from "node:crypto";
import type { Block, ParsedDoc } from "./extract";

export interface ChunkOptions { targetChars: number; maxChars: number; overlapChars: number }
export const DEFAULT_CHUNKING: ChunkOptions = Object.freeze({ targetChars: 900, maxChars: 1300, overlapChars: 160 });

export interface Chunk {
  id: string;
  ordinal: number;
  text: string;
  heading: string;
  page: number | null;
  pageEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  symbol: string | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function splitLong(text: string, max: number, code: boolean): string[] {
  if (text.length <= max) return [text];
  const units = code ? text.split(/(?<=\n)/) : text.split(/(?<=[.!?])\s+(?=[A-Z0-9("'])/);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (u.length > max) { if (cur) { out.push(cur); cur = ""; } for (let i = 0; i < u.length; i += max) out.push(u.slice(i, i + max)); continue; }
    if (cur && cur.length + u.length + 1 > max) { out.push(cur); cur = ""; }
    cur += (cur && !code ? " " : "") + u;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function tailSentences(text: string, max: number): string {
  const s = text.split(/(?<=[.!?])\s+/);
  let tail = "";
  for (let i = s.length - 1; i >= 0; i--) { const next = s[i] + (tail ? " " + tail : ""); if (next.length > max) break; tail = next; }
  return tail;
}

export function chunkDocument(docId: string, doc: ParsedDoc, opts: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  const code = doc.format === "code";
  const chunks: Chunk[] = [];
  let cur: Block[] = [];
  let curLen = 0;
  let prevTail = "";
  let prevSection: string | null = null;

  const sectionKey = (b: Block) => `${b.heading}\u0000${b.symbol ?? ""}`;
  const emit = () => {
    if (!cur.length) return;
    const first = cur[0]!, last = cur[cur.length - 1]!;
    const body = cur.map((b) => b.text).join(code ? "\n" : "\n\n");
    const section = sectionKey(first);
    const overlap = !code && prevSection === section && prevTail ? prevTail + "\n\n" : "";
    const text = overlap + body;
    const ordinal = chunks.length;
    chunks.push({
      id: sha(`${docId}\u0000${ordinal}\u0000${text}`).slice(0, 20), ordinal, text, heading: first.heading,
      page: first.page, pageEnd: last.page, lineStart: first.lineStart, lineEnd: last.lineEnd, symbol: first.symbol,
    });
    prevTail = code ? "" : tailSentences(body, opts.overlapChars);
    prevSection = section;
    cur = []; curLen = 0;
  };

  for (const block of doc.blocks) {
    const pieces = splitLong(block.text, opts.maxChars, code);
    for (const text of pieces) {
      const b = { ...block, text };
      const breaksSection = cur.length > 0 && sectionKey(cur[0]!) !== sectionKey(b);
      if (breaksSection || (cur.length && curLen + text.length > opts.targetChars)) emit();
      if (breaksSection) prevTail = "";
      cur.push(b);
      curLen += text.length;
    }
  }
  emit();
  return chunks;
}
