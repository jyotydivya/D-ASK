// ─────────────────────────────────────────────────────────────────────────────
// Read-only filesystem tools (Phase 7A): search, metadata, read, find_text.
//
// All access goes through fileAccess.ts (roots, canonical paths, exclusions,
// decoding, redaction). Every walk and read is bounded and honours cancellation.
// Nothing here writes, moves, deletes or executes anything.
//
// Each tool's postcondition (check) re-reads the filesystem on its own: listed files
// must still exist inside a root, matched lines must really contain the term, and
// returned text must equal the file's current content. The verifier therefore never
// relies on what the tool said it saw.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { promises as fs, readFileSync, statSync } from "node:fs";
import type { ToolSpec } from "../types";
import {
  DEFAULT_FILE_LIMITS, TEXT_EXTENSIONS, decodeText, extensionOf, kindOf, redactSecrets, relativeInside, resolveInside,
  resolveRoots, splitLines, walk, type FileAccessLimits, type FileRoot, type PathCheck, type ResolvedRoots,
} from "./fileAccess";
import { findTextRequestCheck, metadataRequestCheck, readRequestCheck, searchRequestCheck } from "./filesystemChecks";
import { createSummarizeTool } from "./fileSummary";
import { createOrganizeTools } from "./fileOrganize";
import type { DesktopBridge } from "./desktop";

export interface FileAccessConfig {
  workspaceRoot: string;
  /** Extra folders the user approved (DASK_FS_ROOTS). */
  extraRoots?: readonly string[];
  limits?: Partial<FileAccessLimits>;
  /** Told once which configured roots were refused, so a misconfiguration is visible. */
  onRootsRejected?: (rejected: ResolvedRoots["rejected"]) => void;
}

/** Shared by the four tools: roots are resolved once, on first use. */
export class FileAccess {
  readonly limits: FileAccessLimits;
  private resolved: Promise<ResolvedRoots> | null = null;
  private current: FileRoot[] = [];

  constructor(private readonly config: FileAccessConfig) {
    this.limits = { ...DEFAULT_FILE_LIMITS, ...config.limits };
  }

  async roots(): Promise<FileRoot[]> {
    this.resolved ??= resolveRoots(this.config.workspaceRoot, this.config.extraRoots ?? []).then((r) => {
      if (r.rejected.length) this.config.onRootsRejected?.(r.rejected);
      this.current = r.roots;
      return r;
    });
    return (await this.resolved).roots;
  }

  /** Roots as last resolved, for the synchronous postconditions (execute always runs first). */
  rootsSync(): FileRoot[] { return this.current; }

  /** Like resolveInside, but a bare file name not found at the root is looked up by name (must be unique). */
  async locate(input: string | undefined, signal: AbortSignal): Promise<PathCheck> {
    const roots = await this.roots();
    const direct = await resolveInside(roots, input);
    if (direct.ok || direct.code !== "not_found" || !input || /[\\/]/.test(input)) return direct;
    const wanted = input.toLowerCase();
    const hits: { root: FileRoot; canonical: string; rel: string }[] = [];
    for (const root of roots) {
      await walk(root, root.path, { recursive: true, maxDepth: this.limits.maxDepth, maxEntries: this.limits.maxEntriesVisited, signal }, (e) => {
        if (!e.isDirectory && e.name.toLowerCase() === wanted) hits.push({ root, canonical: e.canonical, rel: e.rel });
        return hits.length <= 5;
      });
    }
    if (signal.aborted) return { ok: false, code: "not_found", error: "Cancelled" };
    if (hits.length === 0) return direct;
    if (hits.length > 1) {
      return { ok: false, code: "ambiguous", error: `${hits.length > 5 ? "More than 5" : hits.length} files are named ${input}: ${hits.slice(0, 5).map((h) => h.rel).join(", ")}. Which one do you mean? Name it with its folder.` };
    }
    return resolveInside(roots, hits[0]!.canonical);
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const fail = (error: string) => ({ ok: false as const, error, evidence: "" });
const iso = (ms: number) => new Date(ms).toISOString();
const shortDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "docs/a.md" in the workspace, "Reports: q3.md" in another root. */
function shown(root: FileRoot, rel: string): string {
  return root.label === "workspace" ? rel : `${root.label}: ${rel}`;
}

function insideSomeRoot(roots: readonly FileRoot[], canonical: string): boolean {
  return roots.some((r) => relativeInside(r.path, canonical) !== null);
}

/** Recomputes a file's lines as the tools see them: decoded, split, then redacted line by line. */
function currentLines(canonical: string): string[] | null {
  try {
    const decoded = decodeText(readFileSync(canonical));
    return decoded.ok ? splitLines(decoded.text) : null;
  } catch {
    return null;
  }
}

const normExt = (e: string | undefined) => (e ?? "").replace(/^\*?\./, "").toLowerCase();

// ── filesystem.search ───────────────────────────────────────────────────────

export interface SearchInput { query?: string; extension?: string; path?: string; recursive?: boolean; sort?: "name" | "modified"; maxResults?: number }
export interface FileHit { path: string; root: string; canonicalPath: string; name: string; extension: string; kind: string; size: number; modified: string; created: string }
export interface SearchOutput {
  path: string; root: string; query: string | null; extension: string | null; sort: "name" | "modified";
  matches: FileHit[]; totalMatches: number; truncated: boolean; entriesVisited: number; skippedLinks: number; stoppedAt: string;
}

export function createSearchTool(access: FileAccess): ToolSpec<SearchInput, SearchOutput> {
  return {
    name: "filesystem.search",
    description: "Find files by name and/or extension inside the folders D-ASK may read (the workspace and folders you approved). " +
      "Returns each file's path, size and dates. `query` is part of the file name; `extension` like \"pdf\"; `path` is the folder to start in; " +
      "`sort` \"modified\" lists the newest first. Reads names only, never contents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100 },
        extension: { type: "string", pattern: "^\\.?[A-Za-z0-9]{1,10}$", maxLength: 11 },
        path: { type: "string", maxLength: 512 },
        recursive: { type: "boolean" },
        sort: { type: "string", enum: ["name", "modified"] },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 10_000,
    async execute(input, ctx) {
      const start = await access.locate(input.path, ctx.signal);
      if (!start.ok) return fail(start.error);
      if (!start.stats.isDirectory()) return fail(`${input.path} is a file, not a folder`);
      // Every word of the query must appear in the file name ("budget report" finds "2026-budget-report.md").
      const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const extension = input.extension ? normExt(input.extension) : null;
      const sort = input.sort ?? "name";
      const maxResults = input.maxResults ?? 50;
      const all: FileHit[] = [];
      const summary = await walk(start.root, start.canonical, {
        recursive: input.recursive ?? true, maxDepth: access.limits.maxDepth, maxEntries: access.limits.maxEntriesVisited, signal: ctx.signal,
      }, (e) => {
        if (e.isDirectory) return;
        if (words.length && !words.every((w) => e.name.toLowerCase().includes(w))) return;
        if (extension && extensionOf(e.name) !== extension) return;
        all.push({
          path: e.rel, root: start.root.label, canonicalPath: e.canonical, name: e.name, extension: extensionOf(e.name),
          kind: kindOf(e.name, false), size: e.stats.size, modified: iso(e.stats.mtimeMs), created: iso(e.stats.birthtimeMs),
        });
      });
      if (summary.stoppedAt === "cancelled") return fail("Cancelled");
      // Deterministic: by path, or newest first with the path as a tie-breaker.
      const byPath = (a: FileHit, b: FileHit) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0);
      all.sort(sort === "modified" ? (a, b) => (Date.parse(b.modified) - Date.parse(a.modified)) || byPath(a, b) : byPath);
      const matches = all.slice(0, maxResults);
      const output: SearchOutput = {
        path: start.rel, root: start.root.label, query: input.query ?? null, extension, sort, matches, totalMatches: all.length,
        truncated: all.length > maxResults || summary.stoppedAt !== "complete", entriesVisited: summary.visited,
        skippedLinks: summary.skippedLinks, stoppedAt: summary.stoppedAt,
      };
      const what = [extension ? `.${extension} files` : "files", words.length ? `named like "${input.query}"` : ""].filter(Boolean).join(" ");
      const head = `Searched ${shown(start.root, start.rel)} (${summary.visited} entries checked) for ${what}: ` +
        (all.length === 0 ? "no matching files." : `${all.length} found${sort === "modified" ? ", newest first" : ""}` +
          `${all.length > matches.length ? ` (showing ${matches.length})` : ""}:`);
      const lines = matches.slice(0, 15).map((m) => `- ${shown(start.root, m.path)} — ${sizeText(m.size)}, modified ${shortDate(Date.parse(m.modified))}, created ${shortDate(Date.parse(m.created))}`);
      const tail = summary.stoppedAt === "entry_limit" ? [`(stopped after ${summary.visited} entries; results may be incomplete)`] : [];
      return { ok: true, output, evidence: [head, ...lines, ...(matches.length > 15 ? [`… and ${matches.length - 15} more`] : []), ...tail].join("\n") };
    },
    check(input, outcome) {
      const o = outcome.output;
      if (!o || !Array.isArray(o.matches)) return { ok: false, reason: "no search result in output" };
      const roots = access.rootsSync();
      const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const ext = input.extension ? normExt(input.extension) : null;
      for (const m of o.matches) {
        if (!insideSomeRoot(roots, m.canonicalPath)) return { ok: false, reason: `${m.path} is not inside a readable folder` };
        try { if (!statSync(m.canonicalPath).isFile()) return { ok: false, reason: `${m.path} is not a file` }; } catch { return { ok: false, reason: `${m.path} does not exist` }; }
        if (words.some((w) => !m.name.toLowerCase().includes(w))) return { ok: false, reason: `${m.name} does not match "${input.query}"` };
        if (ext && extensionOf(m.name) !== ext) return { ok: false, reason: `${m.name} is not a .${ext} file` };
      }
      return { ok: true };
    },
    requestCheck: searchRequestCheck,
  };
}

// ── filesystem.metadata ─────────────────────────────────────────────────────

export interface MetadataOutput {
  path: string; root: string; canonicalPath: string; name: string; extension: string; kind: string;
  type: "file" | "directory"; size: number | null; modified: string; created: string; readableAsText: boolean;
}

export function createMetadataTool(access: FileAccess): ToolSpec<{ path: string }, MetadataOutput> {
  return {
    name: "filesystem.metadata",
    description: "Describe one file or folder D-ASK may read: name, extension, type, size, created and modified times. " +
      "`path` is relative to the workspace (or a bare file name, if it is unique). Never reads contents.",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 512 } }, required: ["path"] },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 5_000,
    async execute(input, ctx) {
      const r = await access.locate(input.path, ctx.signal);
      if (!r.ok) return fail(r.error);
      const isDir = r.stats.isDirectory();
      const name = path.basename(r.canonical);
      const output: MetadataOutput = {
        path: r.rel, root: r.root.label, canonicalPath: r.canonical, name, extension: isDir ? "" : extensionOf(name),
        kind: kindOf(name, isDir), type: isDir ? "directory" : "file", size: isDir ? null : r.stats.size,
        modified: iso(r.stats.mtimeMs), created: iso(r.stats.birthtimeMs), readableAsText: !isDir && TEXT_EXTENSIONS.has(extensionOf(name)),
      };
      const evidence = `${shown(r.root, r.rel)}: ${isDir ? "folder" : `${output.kind} file${output.extension ? ` (.${output.extension})` : ""}, ${sizeText(r.stats.size)}`}; ` +
        `created ${shortDate(r.stats.birthtimeMs)}, modified ${shortDate(r.stats.mtimeMs)}`;
      return { ok: true, output, evidence };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o) return { ok: false, reason: "no metadata in output" };
      if (!insideSomeRoot(access.rootsSync(), o.canonicalPath)) return { ok: false, reason: "not inside a readable folder" };
      try {
        const s = statSync(o.canonicalPath);
        if ((o.type === "file") !== s.isFile()) return { ok: false, reason: "type changed" };
        if (o.type === "file" && s.size !== o.size) return { ok: false, reason: "size does not match the file" };
      } catch {
        return { ok: false, reason: `${o.path} does not exist` };
      }
      return { ok: true };
    },
    requestCheck: metadataRequestCheck,
  };
}

// ── filesystem.read ─────────────────────────────────────────────────────────

export interface ReadInput { path: string; startLine?: number; endLine?: number; heading?: string; maxBytes?: number }
export interface ReadOutput {
  path: string; root: string; canonicalPath: string; encoding: string; totalLines: number;
  startLine: number; endLine: number; section: string | null; text: string; truncated: boolean; redactions: number;
}

const HEADING_ATX = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HEADING_NUMBERED = /^\s*(\d+(?:\.\d+)*)\.?\s+([A-Z][^.!?]{0,80})$/;
const normTitle = (s: string) => s.toLowerCase().replace(/^\s*\d+(\.\d+)*\.?\s*/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** A heading on line i: its level (lower = higher rank) and title. Markdown ATX, setext, or numbered ("2.1 Results"). */
export function headingAt(lines: string[], i: number): { level: number; title: string } | null {
  const line = lines[i]!;
  const atx = HEADING_ATX.exec(line);
  if (atx) return { level: atx[1]!.length, title: atx[2]! };
  const next = lines[i + 1];
  if (next !== undefined && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) return { level: next.trim()[0] === "=" ? 1 : 2, title: line.trim() };
  const num = HEADING_NUMBERED.exec(line);
  if (num) return { level: num[1]!.split(".").length, title: num[2]! };
  return null;
}

/** The section whose heading matches `wanted`: from its heading to the next heading of the same or higher rank. */
export function findSection(lines: string[], wanted: string): { start: number; end: number; title: string } | null {
  const target = normTitle(wanted);
  if (!target) return null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i);
    if (!h) continue;
    const t = normTitle(h.title);
    if (t !== target && !t.startsWith(target + " ")) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = headingAt(lines, j);
      if (n && n.level <= h.level) { end = j; break; }
    }
    return { start: i + 1, end, title: h.title };
  }
  return null;
}

export function createReadTool(access: FileAccess): ToolSpec<ReadInput, ReadOutput> {
  return {
    name: "filesystem.read",
    description: "Read a text file D-ASK may read (markdown, text, code, csv, json...). Optional: `heading` reads one section " +
      "(e.g. \"Introduction\"), `startLine`/`endLine` read a line range. Returns the exact text with its line numbers. " +
      "PDF, Office and binary files cannot be read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 512 },
        startLine: { type: "integer", minimum: 1, maximum: 10_000_000 },
        endLine: { type: "integer", minimum: 1, maximum: 10_000_000 },
        heading: { type: "string", minLength: 1, maxLength: 100 },
        maxBytes: { type: "integer", minimum: 256, maximum: 65_536 },
      },
      required: ["path"],
    },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 5_000,
    async execute(input, ctx) {
      const r = await access.locate(input.path, ctx.signal);
      if (!r.ok) return fail(r.error);
      if (!r.stats.isFile()) return fail(`${input.path} is a folder, not a file`);
      const ext = extensionOf(r.canonical);
      if (!TEXT_EXTENSIONS.has(ext)) {
        return fail(`${r.rel} is a ${kindOf(r.canonical, false)} file${ext ? ` (.${ext})` : ""}; only text files can be read`);
      }
      if (r.stats.size > access.limits.maxReadFileBytes) {
        return fail(`${r.rel} is too large to read (${sizeText(r.stats.size)}; the limit is ${sizeText(access.limits.maxReadFileBytes)})`);
      }
      if (ctx.signal.aborted) return fail("Cancelled");
      let buf: Buffer;
      try {
        buf = await fs.readFile(r.canonical, { signal: ctx.signal });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ABORT_ERR" || ctx.signal.aborted) return fail("Cancelled");
        return fail(code === "EACCES" || code === "EPERM" ? `Permission denied: ${r.rel}` : `Cannot read ${r.rel}`);
      }
      const decoded = decodeText(buf);
      if (!decoded.ok) return fail(`${r.rel} is not a readable text file (${decoded.reason})`);
      const lines = splitLines(decoded.text);
      const total = lines.length;

      let start = 1;
      let end = total;
      let section: string | null = null;
      if (input.heading !== undefined) {
        const s = findSection(lines, input.heading);
        if (!s) return fail(`${r.rel} has no section headed "${input.heading}"`);
        start = s.start; end = s.end; section = s.title;
      }
      if (input.startLine !== undefined || input.endLine !== undefined) {
        start = input.startLine ?? start;
        end = Math.min(input.endLine ?? end, total);
        if (start > total) return fail(`${r.rel} has only ${total} lines`);
        if (end < start) return fail(`endLine ${input.endLine} is before startLine ${start}`);
      }
      if (total === 0) { start = 0; end = 0; }

      const maxBytes = input.maxBytes ?? 16_384;
      const picked: string[] = [];
      let bytes = 0;
      let truncated = false;
      for (let i = start; i <= end && i >= 1; i++) {
        const line = lines[i - 1]!;
        const size = Buffer.byteLength(line, "utf8") + 1;
        if (bytes + size > maxBytes && picked.length > 0) { truncated = true; break; }
        picked.push(line);
        bytes += size;
      }
      const lastLine = picked.length ? start + picked.length - 1 : start;
      const red = redactSecrets(picked.join("\n"));
      const output: ReadOutput = {
        path: r.rel, root: r.root.label, canonicalPath: r.canonical, encoding: decoded.encoding, totalLines: total,
        startLine: start, endLine: lastLine, section, text: red.text, truncated, redactions: red.count,
      };
      const where = section ? `section "${section}", lines ${start}–${lastLine}` : `lines ${start}–${lastLine}`;
      const shownText = red.text.length > 2000 ? `${red.text.slice(0, 2000)}\n…` : red.text;
      const notes = [truncated ? "truncated at the read limit" : "", red.count ? `${red.count} secret value(s) redacted` : ""].filter(Boolean);
      return {
        ok: true,
        output,
        evidence: `Read ${shown(r.root, r.rel)}, ${where} of ${total}${notes.length ? ` (${notes.join("; ")})` : ""}:\n${shownText}`,
      };
    },
    check(_input, outcome) {
      const o = outcome.output;
      if (!o || typeof o.text !== "string") return { ok: false, reason: "no text in output" };
      if (!insideSomeRoot(access.rootsSync(), o.canonicalPath)) return { ok: false, reason: "not inside a readable folder" };
      // Independently re-read the file: the returned text must be exactly those lines.
      const lines = currentLines(o.canonicalPath);
      if (!lines) return { ok: false, reason: `${o.path} can no longer be read` };
      if (o.startLine === 0) return lines.length === 0 ? { ok: true } : { ok: false, reason: "file is not empty" };
      const expected = redactSecrets(lines.slice(o.startLine - 1, o.endLine).join("\n")).text;
      return expected === o.text ? { ok: true } : { ok: false, reason: `the returned text is not lines ${o.startLine}–${o.endLine} of ${o.path}` };
    },
    requestCheck: readRequestCheck,
  };
}

// ── filesystem.find_text ────────────────────────────────────────────────────

export interface FindTextInput { query: string; path?: string; extension?: string; maxResults?: number }
export interface TextMatch { path: string; root: string; canonicalPath: string; line: number; text: string }
export interface FindTextOutput {
  query: string; path: string; root: string; extension: string | null; matches: TextMatch[]; truncated: boolean;
  filesScanned: number; filesWithMatches: number; skipped: { tooLarge: number; notText: number; unreadable: number }; stoppedAt: string;
}

export function createFindTextTool(access: FileAccess): ToolSpec<FindTextInput, FindTextOutput> {
  return {
    name: "filesystem.find_text",
    description: "Search inside text files D-ASK may read for a word or phrase (case-insensitive). Returns each matching line with " +
      "its file and line number. `path` is the folder to search (default: the workspace); `extension` limits the file type.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 100 },
        path: { type: "string", maxLength: 512 },
        extension: { type: "string", pattern: "^\\.?[A-Za-z0-9]{1,10}$", maxLength: 11 },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
    },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 15_000,
    async execute(input, ctx) {
      const start = await access.locate(input.path, ctx.signal);
      if (!start.ok) return fail(start.error);
      if (!start.stats.isDirectory()) return fail(`${input.path} is a file, not a folder`);
      const needle = input.query.toLowerCase();
      const extension = input.extension ? normExt(input.extension) : null;
      const maxResults = input.maxResults ?? 50;
      const L = access.limits;
      const matches: TextMatch[] = [];
      const files = new Set<string>();
      const skipped = { tooLarge: 0, notText: 0, unreadable: 0 };
      let filesScanned = 0;
      let bytesRead = 0;
      let full = false;
      let limitHit: string | null = null;

      const summary = await walk(start.root, start.canonical, { recursive: true, maxDepth: L.maxDepth, maxEntries: L.maxEntriesVisited, signal: ctx.signal }, async (e) => {
        if (e.isDirectory) return;
        const ext = extensionOf(e.name);
        if (extension && ext !== extension) return;
        if (!TEXT_EXTENSIONS.has(ext)) { skipped.notText++; return; }
        if (e.stats.size > L.maxScanFileBytes) { skipped.tooLarge++; return; }
        if (filesScanned >= L.maxScanFiles) { limitHit = "file limit"; return false; }
        if (bytesRead + e.stats.size > L.maxScanTotalBytes) { limitHit = "byte limit"; return false; }
        let buf: Buffer;
        try { buf = await fs.readFile(e.canonical); } catch { skipped.unreadable++; return; }
        filesScanned++;
        bytesRead += buf.length;
        const decoded = decodeText(buf);
        if (!decoded.ok) { skipped.notText++; return; }
        const lines = splitLines(decoded.text);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.toLowerCase().includes(needle)) continue;
          if (matches.length >= maxResults) { full = true; return false; }
          const red = redactSecrets(lines[i]!.trim());
          matches.push({ path: e.rel, root: start.root.label, canonicalPath: e.canonical, line: i + 1, text: red.text.length > 200 ? red.text.slice(0, 200) + "…" : red.text });
          files.add(e.canonical);
        }
        if (ctx.signal.aborted) return false;
      });
      if (summary.stoppedAt === "cancelled" || ctx.signal.aborted) return fail("Cancelled");
      const stoppedAt = full ? "result limit" : limitHit ?? summary.stoppedAt;
      const output: FindTextOutput = {
        query: input.query, path: start.rel, root: start.root.label, extension, matches, truncated: stoppedAt !== "complete",
        filesScanned, filesWithMatches: files.size, skipped, stoppedAt,
      };
      const head = `Searched ${filesScanned} text file${filesScanned === 1 ? "" : "s"} under ${shown(start.root, start.rel)} for "${input.query}": ` +
        (matches.length === 0 ? "no matches." : `${matches.length}${full ? "+" : ""} matching line${matches.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"}:`);
      const lines = matches.slice(0, 20).map((m) => `- ${shown(start.root, m.path)}:${m.line}: ${m.text}`);
      const notes = [
        matches.length > 20 ? `… and ${matches.length - 20} more lines` : "",
        stoppedAt !== "complete" ? `(stopped at the ${stoppedAt}; there may be more)` : "",
        skipped.tooLarge ? `(${skipped.tooLarge} file(s) over ${sizeText(L.maxScanFileBytes)} not searched)` : "",
      ].filter(Boolean);
      return { ok: true, output, evidence: [head, ...lines, ...notes].join("\n") };
    },
    check(input, outcome) {
      const o = outcome.output;
      if (!o || !Array.isArray(o.matches)) return { ok: false, reason: "no matches array in output" };
      const roots = access.rootsSync();
      const needle = input.query.toLowerCase();
      const cache = new Map<string, string[] | null>();
      // Independently re-read each file: every reported line must exist and contain the term.
      for (const m of o.matches) {
        if (!insideSomeRoot(roots, m.canonicalPath)) return { ok: false, reason: `${m.path} is not inside a readable folder` };
        if (!cache.has(m.canonicalPath)) cache.set(m.canonicalPath, currentLines(m.canonicalPath));
        const lines = cache.get(m.canonicalPath);
        const line = lines?.[m.line - 1];
        if (line === undefined || !line.toLowerCase().includes(needle)) return { ok: false, reason: `${m.path}:${m.line} does not contain "${input.query}"` };
      }
      return { ok: true };
    },
    requestCheck: findTextRequestCheck,
  };
}

/** The four read-only filesystem tools over one shared access policy. */
export function createFilesystemTools(config: FileAccessConfig, bridge?: DesktopBridge): ToolSpec<any, any>[] {
  const access = new FileAccess(config);
  // Organisation: the preview is read-only; organise/undo only with the daemon bridge (the daemon validates and moves).
  return [createSearchTool(access), createMetadataTool(access), createReadTool(access), createFindTextTool(access), createSummarizeTool(access),
    ...createOrganizeTools(access, bridge)];
}
