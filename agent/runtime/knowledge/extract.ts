// ─────────────────────────────────────────────────────────────────────────────
// Document ingestion: a local file -> structured blocks that keep their place in the source (heading path, page, line range,
// code symbol). Formats: PDF, DOCX, Markdown, plain text, HTML, source code, CSV/JSON/YAML-like text. Everything else is
// "unsupported" and never read. Credential-looking strings are redacted before anything is indexed.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { decodeText, redactSecrets } from "../tools/fileAccess";
import { extractPdfText } from "./pdf";
import { readZipFile } from "./zip";

export type DocFormat = "pdf" | "docx" | "markdown" | "text" | "html" | "code" | "data";

export interface Block {
  text: string;
  /** Heading path, e.g. "3 Method > 3.2 Graph attention". Empty when the document has none. */
  heading: string;
  page: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** Code only: the function / class / declaration this block belongs to. */
  symbol: string | null;
}

export interface ParsedDoc { title: string; format: DocFormat; blocks: Block[]; pages: number | null; redactions: number }

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "cs", "rs", "go", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "hpp", "cc", "ps1", "psm1", "sh", "bash", "sql", "css", "scss", "lua", "r", "scala", "dart", "vue", "svelte"]);
const DATA_EXT = new Set(["csv", "tsv", "json", "yaml", "yml", "toml", "ini", "xml", "cfg", "conf"]);
const TEXT_EXT = new Set(["txt", "text", "log", "rst", "org", "tex"]);

export function formatOf(file: string): DocFormat | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (TEXT_EXT.has(ext)) return "text";
  if (CODE_EXT.has(ext)) return "code";
  if (DATA_EXT.has(ext)) return "data";
  return null;
}

export class UnreadableError extends Error {}

export function parseDocument(file: string, buf: Buffer): ParsedDoc {
  const format = formatOf(file);
  if (!format) throw new UnreadableError("unsupported file type");
  const base = path.basename(file);
  let doc: ParsedDoc;
  switch (format) {
    case "pdf": doc = parsePdf(buf, base); break;
    case "docx": doc = parseDocx(buf, base); break;
    default: {
      const d = decodeText(buf);
      if (!d.ok) throw new UnreadableError(d.reason);
      const text = d.text.replace(/\r\n?/g, "\n");
      doc = format === "markdown" ? parseMarkdown(text, base)
        : format === "html" ? parsePlain(htmlToText(text), base, "html", htmlTitle(text))
        : format === "code" ? parseCode(text, base)
        : parsePlain(text, base, format, null);
    }
  }
  let redactions = 0;
  doc.blocks = doc.blocks
    .map((b) => { const r = redactSecrets(b.text); redactions += r.count; return { ...b, text: r.text.trim() }; })
    .filter((b) => b.text.length > 0);
  if (doc.blocks.length === 0) throw new UnreadableError(format === "pdf" ? "no extractable text (scanned or image-only PDF?)" : "no text content");
  return { ...doc, redactions };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const SECTION_WORDS = /^(abstract|introduction|background|related work|preliminaries|method(?:s|ology)?|approach|model|experiments?|experimental (?:setup|results)|evaluation|results(?: and discussion)?|discussion|limitations|future work|conclusions?(?: and future work)?|acknowledg(?:e)?ments?|references|bibliography|appendix(?: [a-z])?)\s*$/i;
const NUMBERED_HEADING = /^((?:\d{1,2}\.){0,3}\d{1,2}\.?|[IVX]{1,5}\.|[A-H]\.)\s+([A-Z][^\n]{2,80})$/;

/** Small-caps headings extract as "I NTRODUCTION" / "S TATE - OF - THE - ART": join them back. */
export function unSmallCaps(s: string): string {
  return s.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, "$1").replace(/([A-Z]) ?- ?(?=[A-Z])/g, "$1-");
}

export function headingOf(line: string): string | null {
  const l = unSmallCaps(line.trim());
  if (l.length < 3 || l.length > 90 || /[.:;,]$/.test(l) && !/^\d/.test(l)) return null;
  if (SECTION_WORDS.test(l)) return l.replace(/\s+/g, " ");
  const m = NUMBERED_HEADING.exec(l);
  // A heading reads as words: no maths punctuation, at least one real word, mostly letters.
  if (m && !/\d{3,}/.test(m[2]!) && m[2]!.split(/\s+/).length <= 10 && !/[=<>+;{}|]|\(\s*\w?\s*\)|\s[,(]\s|\(\s*\w*$/.test(m[2]!) && /[A-Za-z]{3,}/.test(m[2]!)
    && (m[2]!.match(/[A-Za-z\s]/g)?.length ?? 0) / m[2]!.length >= 0.75) return l.replace(/\s+/g, " ");
  return null;
}

const RUNNING_HEADER = /^(published\s+as|preprint|accepted\s+(?:at|to|for)|under\s+review|arxiv:|proceedings\s+of|workshop\s+on|journal\s+of|vol(?:ume)?\.?\s*\d|copyright|©)/i;

function parsePdf(buf: Buffer, base: string): ParsedDoc {
  const pdf = extractPdfText(buf);
  if (pdf.encrypted) throw new UnreadableError("the PDF is encrypted");
  const blocks: Block[] = [];
  let heading = "";
  let firstLines: string[] = [];
  pdf.pages.forEach((pageText, i) => {
    const page = i + 1;
    let para: string[] = [];
    const flush = () => { if (para.length) { blocks.push({ text: joinLines(para), heading, page, lineStart: null, lineEnd: null, symbol: null }); para = []; } };
    for (const raw of pageText.split("\n")) {
      const line = raw.trim();
      if (page === 1 && firstLines.length < 4 && line.length > 8 && !RUNNING_HEADER.test(line)) firstLines.push(line);
      if (!line) { flush(); continue; }
      if (/^\d{1,4}$/.test(line) || RUNNING_HEADER.test(line)) continue; // page numbers and running headers
      const h = headingOf(line);
      if (h) { flush(); heading = h; continue; }
      para.push(line);
      if (/[.!?]$/.test(line) && para.join(" ").length > 600) flush();
    }
    flush();
  });
  const title = pdf.title && !/^(untitled|microsoft word|document\d*)/i.test(pdf.title) ? pdf.title : (firstLines[0] && firstLines[0].length < 160 ? pdfTitle(firstLines) : base);
  return { title, format: "pdf", blocks, pages: pdf.pages.length, redactions: 0 };
}

/** A title set in capitals (or ending on a joining word) often wraps onto a second line. */
function pdfTitle(lines: string[]): string {
  const a = unSmallCaps(lines[0]!), b = lines[1] ? unSmallCaps(lines[1]) : "";
  const caps = (s: string) => s.length > 3 && s === s.toUpperCase() && /[A-Z]{3}/.test(s);
  return b && b.length < 120 && ((caps(a) && caps(b)) || /\b(with|of|for|on|and|in|to|the|via|using|a)$/i.test(a)) ? `${a} ${b}` : a;
}

function joinLines(lines: string[]): string { return lines.join(" ").replace(/\s+/g, " ").trim(); }

// ── DOCX ────────────────────────────────────────────────────────────────────

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e] ?? m);
}

function parseDocx(buf: Buffer, base: string): ParsedDoc {
  let xml: string;
  try {
    const body = readZipFile(buf, "word/document.xml");
    if (!body) throw new UnreadableError("not a Word document (word/document.xml missing)");
    xml = body.toString("utf8");
  } catch (e) { throw e instanceof UnreadableError ? e : new UnreadableError(`corrupt .docx: ${e instanceof Error ? e.message : e}`); }
  let title: string | null = null;
  try { const core = readZipFile(buf, "docProps/core.xml")?.toString("utf8"); const m = core && /<dc:title>([^<]*)<\/dc:title>/.exec(core); if (m && m[1]!.trim()) title = xmlText(m[1]!.trim()); } catch { /* optional */ }
  const blocks: Block[] = [];
  const path_: string[] = [];
  let ordinal = 0;
  for (const p of xml.split(/<\/w:p>/)) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    const text = xmlText([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g)]
      .map((m) => m[1] ?? (m[0].startsWith("<w:tab") ? "\t" : "\n")).join("")).trim();
    if (!text) continue;
    ordinal++;
    const lvl = /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1] ?? (/^Title$/i.test(style) ? "0" : null);
    if (lvl !== null) {
      if (lvl === "0") { title = title ?? text; continue; }
      const n = Number(lvl);
      path_.length = Math.max(0, n - 1);
      path_[n - 1] = text;
      continue;
    }
    blocks.push({ text, heading: path_.filter(Boolean).join(" > "), page: null, lineStart: ordinal, lineEnd: ordinal, symbol: null });
  }
  return { title: title ?? base, format: "docx", blocks, pages: null, redactions: 0 };
}

// ── Markdown / text / HTML ──────────────────────────────────────────────────

function parseMarkdown(text: string, base: string): ParsedDoc {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const hp: string[] = [];
  let title: string | null = null;
  let para: string[] = [];
  let paraStart = 1;
  let inFence = false;
  const flush = (end: number) => { if (para.length) { blocks.push({ text: para.join("\n").trim(), heading: hp.filter(Boolean).join(" > "), page: null, lineStart: paraStart, lineEnd: end, symbol: null }); para = []; } };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush(n - 1);
      const level = h[1]!.length;
      if (level === 1 && !title) title = h[2]!;
      hp.length = level - 1;
      hp[level - 1] = h[2]!;
      return;
    }
    if (!inFence && line.trim() === "") { flush(n - 1); return; }
    if (para.length === 0) paraStart = n;
    para.push(line);
  });
  flush(lines.length);
  return { title: title ?? base, format: "markdown", blocks, pages: null, redactions: 0 };
}

function parsePlain(text: string, base: string, format: DocFormat, title: string | null): ParsedDoc {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let heading = "";
  let para: string[] = [];
  let paraStart = 1;
  const flush = (end: number) => { if (para.length) { blocks.push({ text: para.join("\n").trim(), heading, page: null, lineStart: paraStart, lineEnd: end, symbol: null }); para = []; } };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.trim() === "") { flush(n - 1); return; }
    const h = format === "text" ? headingOf(line) : null;
    if (h && para.length === 0) { heading = h; return; }
    if (para.length === 0) paraStart = n;
    para.push(line);
  });
  flush(lines.length);
  const firstLine = lines.find((l) => l.trim().length > 3)?.trim();
  return { title: title ?? (format === "text" && firstLine && firstLine.length <= 100 ? firstLine : base), format, blocks, pages: null, redactions: 0 };
}

/** A web page's extracted text (from the browser reader) as a document: paragraphs, short title-like lines as headings, secrets redacted. */
export function parseWebPage(title: string, text: string): ParsedDoc {
  const doc = parsePlain(text.replace(/\r\n?/g, "\n"), title, "html", title);
  let redactions = 0;
  doc.blocks = doc.blocks.map((b) => { const r = redactSecrets(b.text); redactions += r.count; return { ...b, text: r.text.trim() }; }).filter((b) => b.text.length > 0);
  if (!doc.blocks.length) throw new UnreadableError("the page has no readable text");
  return { ...doc, redactions };
}

function htmlTitle(html: string): string | null { const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html); return m ? xmlText(m[1]!.trim()) : null; }
function htmlToText(html: string): string {
  return xmlText(html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

// ── Source code ─────────────────────────────────────────────────────────────

// A top-level (or class-member) declaration starts a new block, so a chunk is one function / class / type where possible.
const DECL = /^(\s{0,4})(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|sealed\s+|partial\s+|override\s+|virtual\s+|readonly\s+|pub(?:\([a-z]+\))?\s+|unsafe\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl|fn|def|const|let|record|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const CS_METHOD = /^(\s{4,8})(?:public|private|protected|internal|static|async|override|virtual)\s[\w<>\[\],\s]*?\s([A-Z][\w]*)\s*\(/;

function parseCode(text: string, base: string): ParsedDoc {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let start = 1; let symbol: string | null = null; let buf: string[] = [];
  const flush = (end: number) => {
    while (buf.length && buf[buf.length - 1]!.trim() === "") { buf.pop(); end--; } // trailing blank lines are not part of the range
    const body = buf.join("\n");
    if (body.trim()) blocks.push({ text: body, heading: symbol ?? "", page: null, lineStart: start, lineEnd: end, symbol });
    buf = [];
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    const m = DECL.exec(line) ?? CS_METHOD.exec(line);
    if (m && buf.join("").trim() !== "" && !/^\s*(?:\/\/|#|\*)/.test(line)) {
      // Keep the comment block directly above a declaration with it.
      const lead: string[] = [];
      while (buf.length && /^\s*(?:\/\/|\/?\*|#(?!include)|""")/.test(buf[buf.length - 1]!)) lead.unshift(buf.pop()!);
      flush(n - 1 - lead.length);
      start = n - lead.length; buf = lead; symbol = m[2]!;
    } else if (m && !symbol) symbol = m[2]!;
    buf.push(line);
  });
  flush(lines.length);
  return { title: base, format: "code", blocks, pages: null, redactions: 0 };
}
