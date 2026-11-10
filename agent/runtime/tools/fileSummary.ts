// ─────────────────────────────────────────────────────────────────────────────
// filesystem.summarize — a deterministic, EXTRACTIVE summary of one file or folder the user names (read-only).
//
//   text file  → outline (headings), word/line counts, and up to N key sentences quoted verbatim with their line;
//   csv / tsv  → columns and row count;   json → top-level keys;
//   folder     → files and folders, totals by kind, newest and largest files (non-recursive listing + bounded walk).
//
// No model writes the summary, so every statement is checkable: the postcondition re-reads the file and requires each
// quoted sentence to be present at its line (after the same redaction the read tool applies), and re-stats the files a
// folder summary lists. Same roots, exclusions and limits as the other filesystem tools; nothing is written.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { promises as fs, readFileSync, statSync } from "node:fs";
import type { ArgumentDomain, GroundingVerdict, ToolRequestCheck, ToolSpec } from "../types";
import { contentWords } from "../grounding";
import { TEXT_EXTENSIONS, decodeText, extensionOf, kindOf, redactSecrets, relativeInside, splitLines, walk } from "./fileAccess";
import { findSection, headingAt, type FileAccess } from "./filesystem";
import { SUMMARIZE, isTextSearch, requestedFiles, requestedFolders, requestedSection } from "./filesystemChecks";

export interface SummarizeInput { path: string; maxSentences?: number; heading?: string }
export interface KeySentence { line: number; text: string }
export interface SummarizeOutput {
  path: string; canonicalPath: string; type: "text" | "csv" | "json" | "folder"; section?: string | null;
  totalLines?: number; words?: number; headings?: { line: number; level: number; title: string }[]; keySentences?: KeySentence[];
  columns?: string[]; rows?: number; keys?: string[];
  folder?: { files: number; folders: number; totalBytes: number; byKind: Record<string, number>; newest: { path: string; modified: string }[];
    largest: { path: string; size: number }[]; stoppedAt: string };
  redactions: number;
}

const STOP = new Set(("a an the and or but of to in on at for is are was were be been being it its this that these those with as by from " +
  "into than then there their they them we you your our i he she his her not no do does did can could would should will may might must " +
  "has have had also such which who whom what when where why how all any each more most other some so very just about over under").split(" "));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sizeText = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Sentences of prose (not headings, code fences, tables or list markers), each with the line it starts on. */
export function sentencesOf(lines: string[]): KeySentence[] {
  const out: KeySentence[] = [];
  let fenced = false;
  let buf = ""; let bufLine = 0;
  const flush = () => {
    const text = norm(buf);
    if (text) {
      // Split the paragraph into sentences; keep each sentence's starting line as the paragraph's line (verified as a substring).
      for (const s of text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
        const t = s.trim();
        if (t.length >= 10 && t.length <= 400 && /[a-z]/i.test(t) && t.split(/\s+/).length >= 2) out.push({ line: bufLine, text: t });
      }
    }
    buf = ""; bufLine = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    const isHeading = headingAt(lines, i) !== null || /^\s{0,3}(=+|-+)\s*$/.test(raw);
    if (!raw.trim() || isHeading || /^\s*\|/.test(raw)) { flush(); continue; }
    const text = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) { flush(); buf = text; bufLine = i + 1; flush(); continue; }
    if (!buf) bufLine = i + 1;
    buf += " " + text;
  }
  flush();
  return out;
}

/** Top sentences by content-word frequency (normalised by length), position bonus for the opening; returned in document order. */
export function keySentences(sentences: KeySentence[], k: number): KeySentence[] {
  const tf = new Map<string, number>();
  const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
  for (const s of sentences) for (const w of words(s.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const ws = words(s.text);
    const score = ws.reduce((a, w) => a + (tf.get(w) ?? 0), 0) / Math.sqrt(Math.max(ws.length, 1)) * (i < 2 ? 1.3 : 1);
    return { s, i, score };
  });
  const seen = new Set<string>();
  return scored.sort((a, b) => b.score - a.score || a.i - b.i)
    .filter((x) => { const key = x.s.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, k).sort((a, b) => a.i - b.i).map((x) => x.s);
}

function csvColumns(line: string, sep: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === sep && !q) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out.map((c) => c.slice(0, 60)).slice(0, 50);
}

const fail = (error: string) => ({ ok: false as const, error, evidence: "" });

export function createSummarizeTool(access: FileAccess): ToolSpec<SummarizeInput, SummarizeOutput> {
  return {
    name: "filesystem.summarize",
    description: "Summarise ONE text file or folder the user names, extractively: outline, key sentences quoted with their line numbers " +
      "(text), columns and rows (CSV), top-level keys (JSON), or counts, kinds, newest and largest files (folder). Never writes.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, maxLength: 512 }, maxSentences: { type: "integer", minimum: 1, maximum: 8 }, heading: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["path"],
    },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 15_000,
    async execute(input, ctx) {
      const r = await access.locate(input.path, ctx.signal);
      if (!r.ok) return fail(r.error);
      const shownPath = r.root.label === "workspace" ? r.rel : `${r.root.label}: ${r.rel}`;
      if (r.stats.isDirectory()) {
        const byKind: Record<string, number> = {};
        const files: { path: string; size: number; mtime: number }[] = [];
        let folders = 0; let total = 0;
        const w = await walk(r.root, r.canonical, { recursive: true, maxDepth: 3, maxEntries: access.limits.maxEntriesVisited, signal: ctx.signal }, (e) => {
          if (e.isDirectory) { folders++; return; }
          const k = kindOf(e.name, false);
          byKind[k] = (byKind[k] ?? 0) + 1; total += e.stats.size;
          files.push({ path: e.rel, size: e.stats.size, mtime: e.stats.mtimeMs });
        });
        if (w.stoppedAt === "cancelled") return fail("Cancelled");
        const newest = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 5).map((f) => ({ path: f.path, modified: new Date(f.mtime).toISOString() }));
        const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({ path: f.path, size: f.size }));
        const output: SummarizeOutput = { path: r.rel, canonicalPath: r.canonical, type: "folder", redactions: 0,
          folder: { files: files.length, folders, totalBytes: total, byKind, newest, largest, stoppedAt: w.stoppedAt } };
        const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
        const evidence = [`Folder ${shownPath}: ${files.length} file(s) in ${folders} subfolder(s) (up to 3 levels deep), ${sizeText(total)}` +
          `${w.stoppedAt !== "complete" ? " (listing stopped at the entry limit: counts are partial)" : ""}.`,
          kinds ? `By kind: ${kinds}.` : "No files.",
          newest.length ? `Newest: ${newest.map((f) => `${f.path} (${f.modified.slice(0, 10)})`).join("; ")}.` : "",
          largest.length ? `Largest: ${largest.map((f) => `${f.path} (${sizeText(f.size)})`).join("; ")}.` : ""].filter(Boolean).join("\n");
        return { ok: true, output, evidence };
      }
      const ext = extensionOf(r.canonical);
      if (!TEXT_EXTENSIONS.has(ext)) return fail(`${r.rel} is a ${kindOf(r.canonical, false)} file${ext ? ` (.${ext})` : ""}; only text files can be summarised`);
      if (r.stats.size > access.limits.maxReadFileBytes) return fail(`${r.rel} is too large to summarise (${sizeText(r.stats.size)})`);
      let buf: Buffer;
      try { buf = await fs.readFile(r.canonical, { signal: ctx.signal }); } catch { return fail(ctx.signal.aborted ? "Cancelled" : `Cannot read ${r.rel}`); }
      const decoded = decodeText(buf);
      if (!decoded.ok) return fail(`${r.rel} is not a readable text file (${decoded.reason})`);
      const red = redactSecrets(decoded.text);
      const lines = splitLines(red.text);
      const base = { path: r.rel, canonicalPath: r.canonical, totalLines: lines.length, redactions: red.count };
      if (ext === "csv" || ext === "tsv") {
        const nonEmpty = lines.filter((l) => l.trim());
        const columns = nonEmpty.length ? csvColumns(nonEmpty[0]!, ext === "tsv" ? "\t" : ",") : [];
        const output: SummarizeOutput = { ...base, type: "csv", columns, rows: Math.max(nonEmpty.length - 1, 0) };
        return { ok: true, output, evidence: `${shownPath}: a table with ${output.rows} data row(s) and ${columns.length} column(s): ${columns.join(", ")}.` };
      }
      if (ext === "json") {
        try {
          const v = JSON.parse(red.text);
          const keys = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).slice(0, 50) : [];
          const output: SummarizeOutput = { ...base, type: "json", keys };
          return { ok: true, output, evidence: Array.isArray(v) ? `${shownPath}: a JSON array of ${v.length} item(s).` : `${shownPath}: a JSON object with ${keys.length} top-level key(s): ${keys.join(", ")}.` };
        } catch { /* not valid JSON: summarise as text */ }
      }
      // One section only, when the request names one: lines [first, last] (1-based, inclusive), numbering kept absolute.
      let first = 1; let last = lines.length; let section: string | null = null;
      if (input.heading !== undefined) {
        const s = findSection(lines, input.heading);
        if (!s) return fail(`${r.rel} has no section headed "${input.heading}"`);
        first = s.start; last = s.end; section = s.title;
      }
      const scope = lines.slice(first - 1, last);
      const headings: { line: number; level: number; title: string }[] = [];
      for (let i = 0; i < scope.length && headings.length < 40; i++) { const h = headingAt(scope, i); if (h) headings.push({ line: first + i, level: h.level, title: h.title.slice(0, 120) }); }
      const k = input.maxSentences ?? 5;
      const picked = keySentences(sentencesOf(scope).map((s) => ({ line: s.line + first - 1, text: s.text })), k);
      const words = (scope.join("\n").match(/[\p{L}\p{N}]+/gu) ?? []).length;
      const output: SummarizeOutput = { ...base, type: "text", section, words, headings, keySentences: picked };
      const evidence = [`Summary of ${section ? `the "${section}" section (lines ${first}–${last}) of ` : ""}${shownPath} (${scope.length} lines, ${words} words${red.count ? `; ${red.count} secret value(s) redacted` : ""}).`,
        headings.length ? `Outline: ${headings.slice(0, 12).map((h) => `${"  ".repeat(Math.max(h.level - 1, 0))}${h.title} (line ${h.line})`).join("; ")}${headings.length > 12 ? "; …" : ""}.` : "",
        picked.length ? `Key sentences (quoted from the file):\n${picked.map((s) => `- line ${s.line}: "${s.text}"`).join("\n")}` : "No prose sentences found."].filter(Boolean).join("\n");
      return { ok: true, output, evidence };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o) return { ok: false, reason: "no summary in output" };
      const root = access.rootsSync().find((rt) => relativeInside(rt.path, o.canonicalPath) !== null);
      if (!root) return { ok: false, reason: "not inside a readable folder" };
      if (o.type === "folder") {
        // Listed paths are relative to the root; each must still exist, inside the summarised folder.
        for (const f of [...(o.folder?.newest ?? []), ...(o.folder?.largest ?? [])]) {
          const full = path.join(root.path, f.path);
          if (relativeInside(o.canonicalPath, full) === null) return { ok: false, reason: `${f.path} is not inside the folder` };
          try { statSync(full); } catch { return { ok: false, reason: `${f.path} no longer exists` }; }
        }
        return { ok: true };
      }
      let lines: string[];
      try {
        const d = decodeText(readFileSync(o.canonicalPath));
        if (!d.ok) return { ok: false, reason: "the file can no longer be decoded" };
        lines = splitLines(redactSecrets(d.text).text);
      } catch { return { ok: false, reason: `${o.path} can no longer be read` }; }
      for (const s of o.keySentences ?? []) {
        // The sentence starts in its paragraph at or after its line; the paragraph spans at most a few lines.
        const window = norm(lines.slice(Math.max(s.line - 1, 0), s.line + 15).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")).join(" "));
        if (!window.includes(s.text)) return { ok: false, reason: `line ${s.line} does not contain the quoted sentence` };
      }
      return { ok: true };
    },
    requestCheck: summarizeRequestCheck,
  };
}

// ── Request check ───────────────────────────────────────────────────────────

// The summarise intent is shared with the other filesystem checks (filesystemChecks.SUMMARIZE).
/** The file(s) or folder(s) a summarise request names. A request that names none gets no facet (and the read check asks which). */
export function summarizeTargets(objective: string): string[] {
  if (!SUMMARIZE.test(objective) || isTextSearch(objective)) return [];
  const files = requestedFiles(objective);
  return files.length ? files : requestedFolders(objective);
}
export const isSummarizeRequest = (o: string) => summarizeTargets(o).length > 0;

/** The section of a NAMED FILE the request asks to summarise; words of the trigger itself ("overview of", "summary of") are not sections. */
export function summarySection(objective: string): string | null {
  if (!requestedFiles(objective).length) return null;
  return requestedSection(objective.replace(SUMMARIZE, " "));
}

function sentenceCount(objective: string): number | null {
  const m = /\b(?:in|to|top|first|give\s+me)\s+(\d|one|two|three|four|five|six|seven|eight)\s+(?:sentences?|points?|bullets?|lines?)\b/i.exec(objective);
  if (!m) return null;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const n = words[m[1]!.toLowerCase()] ?? Number(m[1]);
  return n >= 1 && n <= 8 ? n : null;
}

const pnorm = (p: string) => { const n = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase(); return n === "" ? "." : n; };
const named = (outputPath: string, target: string) => { const o = pnorm(outputPath); const t = pnorm(target); return o === t || o.endsWith("/" + t) || /^[a-z]:\//.test(t); };
const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });

export const summarizeRequestCheck: ToolRequestCheck<SummarizeInput, SummarizeOutput> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    const t = summarizeTargets(objective);
    if (!t.length) return { path: { kind: "forbidden", reason: "the request names no file or folder to summarise" } };
    const n = sentenceCount(objective);
    return {
      path: { kind: "enum", values: t, optional: false, compare: "path" },
      // A named number is pinned by ground() (domains compare strings); none named: the default is used.
      ...(n ? {} : { maxSentences: { kind: "forbidden", reason: "the request names no number of sentences" } as ArgumentDomain }),
      heading: summarySection(objective) ? { kind: "enum", values: [summarySection(objective)!], optional: false } : { kind: "forbidden", reason: "the request names no section" },
    };
  },
  relevant: (o) => SUMMARIZE.test(o),
  facets(objective) {
    const section = summarySection(objective);
    return summarizeTargets(objective).map((t) => ({ id: `summarize:${t}${section ? `#${section}` : ""}`, tool: "filesystem.summarize",
      description: `summarise ${section ? `the ${section} of ` : ""}${t}`, data: { target: t, section } }));
  },
  ground(input, objective) {
    const t = summarizeTargets(objective);
    if (!t.length) return { status: "ungrounded", reason: "the request does not ask to summarise a named file or folder" };
    if (!t.includes(pnorm(input.path))) return { status: "contradicted", reason: `the request names ${t.join(", ")}` };
    const n = sentenceCount(objective);
    if ((n ?? undefined) !== input.maxSentences) return { status: "contradicted", reason: n ? `the request asks for ${n} sentences` : "the request names no number of sentences; omit maxSentences" };
    const section = summarySection(objective);
    if ((section ?? "").toLowerCase() !== (input.heading ?? "").toLowerCase()) return { status: "contradicted", reason: section ? `the request asks for the "${section}" section` : "the request names no section; omit heading" };
    return grounded(`${input.path} is named in the request`);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    const d = facet.data as { target: string; section: string | null };
    if (!outcome.ok || !o || pnorm(input.path) !== d.target || !named(o.path, d.target)) return false;
    if (d.section && !(o.section ?? "").toLowerCase().replace(/^\s*\d+(\.\d+)*\.?\s*/, "").startsWith(d.section.toLowerCase())) return false;
    if (o.type === "folder") return o.folder?.stoppedAt === "complete";
    if (o.type === "text") return (o.keySentences?.length ?? 0) > 0 || (o.headings?.length ?? 0) > 0;
    return true;
  },
  vocabulary(objective) {
    return ["summarise", "summarize", "summary", "summarized", "summarised", "sum", "up", "tldr", "gist", "key", "main", "points", "point", "overview",
      "of", "the", "this", "file", "folder", "document", "report", "notes", "in", "into", "sentences", "sentence", "bullets", "bullet", "lines",
      "give", "me", "please", "briefly", "short", "quick", "one", "two", "three", "four", "five", "six", "seven", "eight", "top", "first",
      "section", "part", ...(summarySection(objective)?.toLowerCase().split(/\s+/) ?? []),
      ...summarizeTargets(objective).flatMap((t) => [...t.split(/[\\/.:_ -]+/), ...contentWords(t)]).map((w) => w.toLowerCase())];
  },
};
