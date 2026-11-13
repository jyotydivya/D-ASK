// ─────────────────────────────────────────────────────────────────────────────
// Deterministic request checks for the filesystem tools (see ../grounding.ts).
//
// Same rules as the built-in checks: they read only the request text and the tool
// call/output, no model is involved, and anything they do not understand yields no
// facet or "ungrounded", which caps the task at "unverified".
//
// Argument domains are what keep the model from choosing what to read: the file,
// folder, extension, name term, search term and section must be the ones the request
// names. A request that names no file cannot ground a read, so it can never be
// reported as completed.
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolOutcome, ToolRequestCheck } from "../types";

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });

// ── Intents ─────────────────────────────────────────────────────────────────

const SEARCH_VERB = /\b(find|search|locate|look\s+for|where\s+(is|are)|which\s+files?)\b/i;
const TEXT_INTENT = /\b(occurrences?|instances?|mentions?|mentioned|mentioning|contain(s|ing)?|appears?|references?\s+to|term|phrase|keyword|grep)\b/i;
const READ_VERB = /\b(read|open|display|print|view|contents?|text|lines?|section|introduction|intro|summary|abstract|conclusions?|overview|background|says?)\b/i;
const META_INTENT = /\b(metadata|size|how\s+(big|large)|when\s+was|created|modified|last\s+(changed|modified|updated)|timestamps?|dates?|details|properties|file\s+info)\b/i;
const LATEST = /\b(latest|newest|most\s+recent(ly)?|recent(ly)?|last\s+(modified|updated|changed))\b/i;
const ROOTISH = /\b(workspace|project|repo(sitory)?|root|top[- ]level|authori[sz]ed|approved)\b/i;
const DOCS_WORDS = /\b(documentation|docs)\b/i;

// ── Extraction helpers ──────────────────────────────────────────────────────

const norm = (p: string) => {
  const n = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
  return n === "" ? "." : n;
};
const baseName = (p: string) => norm(p).split("/").pop() ?? "";
const KNOWN_FILE_EXT = /\.(?:txt|md|markdown|rst|adoc|log|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|m?js|cjs|jsx|tsx?|py|rs|cs|java|kt|go|cpp|hpp|sh|ps1|psm1|bat|cmd|sql|rb|php|swift|lua|pdf|docx?|xlsx?|pptx?|odt|rtf|png|jpe?g|gif|svg|zip|7z|exe|dll)$/i;

/** File names and paths the request names: "docs/report.md", "report.md", "C:\Reports\q3.md". */
export function requestedFiles(objective: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s"'`(“])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{1,7})(?=$|[\s"'`)”,;:?!]|\.(?:\s|$))/g;
  for (const m of objective.matchAll(re)) {
    const candidate = m[1]!.trim();
    if (!KNOWN_FILE_EXT.test(candidate)) continue;
    out.add(norm(candidate));
  }
  // Dotfiles (".env", "the .env file", "docs/.env", ".eslintrc.json"): no name before the dot, so the pattern above never
  // sees them, and the model was left to improvise. Naming one makes it a file request; whether it may be read is still
  // decided only by fileAccess (secret and hidden names are refused). A lowercase letter after the dot: ".NET" and ".5" are not files.
  const dot = /(?:^|[\s"'`(“])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*\.[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*)(?=$|[\s"'`)”,;:?!]|\.(?:\s|$))/g;
  for (const m of objective.matchAll(dot)) out.add(norm(m[1]!.trim()));
  return [...out];
}

/** Folders the request names: slash paths without a file extension, or "the X folder". */
export function requestedFolders(objective: string): string[] {
  const out = new Set<string>();
  for (const m of objective.matchAll(/(?:^|[\s"'`(])((?:\.{1,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+)[\\/]?/g)) {
    if (!KNOWN_FILE_EXT.test(m[1]!)) out.add(norm(m[1]!));
  }
  for (const m of objective.matchAll(/\b(?:the|in|inside|under|of)\s+["'`]?([\w.-]+)["'`]?\s+(?:folder|directory|dir)\b/gi)) {
    if (!/^(the|this|that|current|project|workspace|root|my|authori[sz]ed|approved)$/i.test(m[1]!)) out.add(norm(m[1]!));
  }
  return [...out];
}

const ALWAYS_EXT: Record<string, string> = {
  pdf: "pdf", pdfs: "pdf", markdown: "md", json: "json", csv: "csv", csvs: "csv", xml: "xml", yaml: "yaml", yml: "yml",
  html: "html", docx: "docx", xlsx: "xlsx", pptx: "pptx",
};
const CONTEXT_EXT: Record<string, string> = {
  md: "md", txt: "txt", text: "txt", word: "docx", excel: "xlsx", powerpoint: "pptx", log: "log", logs: "log",
  python: "py", py: "py", typescript: "ts", ts: "ts", javascript: "js", js: "js", cs: "cs", rust: "rs", rs: "rs", powershell: "ps1", ps1: "ps1",
};

/** File types the request asks for: "PDF files", "pdfs", ".md", "markdown", "text files". */
export function requestedExtensions(objective: string): string[] {
  const out = new Set<string>();
  for (const m of objective.matchAll(/(?:^|[\s(*])\.([A-Za-z0-9]{2,8})\b/g)) out.add(m[1]!.toLowerCase());
  for (const m of objective.matchAll(/\b([A-Za-z]+)\b/g)) {
    const w = m[1]!.toLowerCase();
    if (ALWAYS_EXT[w]) out.add(ALWAYS_EXT[w]!);
  }
  for (const m of objective.matchAll(/\b([A-Za-z0-9]+)\s+(?:files?|documents?|docs|scripts?|sources?|reports?)\b/gi)) {
    const w = m[1]!.toLowerCase();
    if (CONTEXT_EXT[w]) out.add(CONTEXT_EXT[w]!);
  }
  return [...out];
}

const EXT_WORDS = [...Object.keys(ALWAYS_EXT), ...Object.keys(CONTEXT_EXT)];

/** The search term of a content search: quoted text, or the word after term/word/phrase, "occurrences of", "containing"... */
export function textQuery(objective: string): string | null {
  const quoted = /["“'‘`]([^"”'’`]{2,100})["”'’`]/.exec(objective);
  if (quoted && TEXT_INTENT.test(objective)) return quoted[1]!.trim();
  const patterns = [
    /\b(?:term|word|phrase|string|keyword)\s+([\w][\w-]*)/i,
    /\b(?:occurrences?|instances?|mentions?|uses?)\s+of\s+(?:the\s+)?([\w][\w-]*)/i,
    /\b(?:containing|contain|contains|mentioning|mention|mentions|referencing|references\s+to|reference\s+to)\s+(?:the\s+)?([\w][\w-]*)/i,
    /\bwhere\s+([\w][\w-]*)\s+(?:is\s+)?(?:mentioned|used|appears)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(objective);
    if (m && !/^(word|term|phrase|text|files?)$/i.test(m[1]!) && m[1]!.length >= 2) return m[1]!;
  }
  return null;
}

const SECTION_ALIASES: Record<string, string> = {
  introduction: "introduction", intro: "introduction", summary: "summary", "executive summary": "executive summary", abstract: "abstract",
  conclusion: "conclusion", conclusions: "conclusions", overview: "overview", background: "background", scope: "scope",
  methodology: "methodology", methods: "methods", results: "results", discussion: "discussion", recommendations: "recommendations",
  requirements: "requirements",
};

/** The section of a document the request asks for. */
export function requestedSection(objective: string): string | null {
  const named = /\bsection\s+(?:called|named|titled|headed)?\s*["“'‘]([^"”'’]{2,60})["”'’]|["“'‘]([^"”'’]{2,60})["”'’]\s+section\b/i.exec(objective);
  if (named) return (named[1] ?? named[2])!.trim();
  const words = objective.toLowerCase();
  for (const key of ["executive summary", ...Object.keys(SECTION_ALIASES)]) {
    if (new RegExp(`\\b${key}\\b`).test(words)) return SECTION_ALIASES[key]!;
  }
  return null;
}

/** A line range the request names: "lines 10-20", "lines 10 to 20", "first 30 lines", "line 7". */
export function requestedLines(objective: string): { start: number; end: number } | null {
  let m = /\blines?\s+(\d+)\s*(?:-|–|—|to|through|until)\s*(\d+)/i.exec(objective);
  if (m) return { start: Number(m[1]), end: Number(m[2]) };
  m = /\bfirst\s+(\d+)\s+lines\b/i.exec(objective);
  if (m) return { start: 1, end: Number(m[1]) };
  m = /\bline\s+(\d+)\b/i.exec(objective);
  if (m) return { start: Number(m[1]), end: Number(m[1]) };
  return null;
}

// ── Which tool a request is for ─────────────────────────────────────────────

/** Requests about the web, not this computer's files ("search the web for today's weather"). */
const NOT_LOCAL = /\b(web|internet|online|google|bing|duckduckgo|websites?|browser|news|youtube)\b/i;

export const isTextSearch = (o: string) => SEARCH_VERB.test(o) && !NOT_LOCAL.test(o) && TEXT_INTENT.test(o) && textQuery(o) !== null;
export const isFileSearch = (o: string) => SEARCH_VERB.test(o) && !NOT_LOCAL.test(o) && !isTextSearch(o) && requestedFiles(o).length === 0;
export const isMetadataRequest = (o: string) => META_INTENT.test(o) && requestedFiles(o).length > 0 && !isTextSearch(o);
/**
 * Summarising needs the file's text, so it counts as a read (the extraction can be verified). "summarize" itself is
 * deliberately absent from READ_VOCAB: no check can confirm a summary, so such a request stays "unverified".
 */
export const SUMMARIZE = /\b(summari[sz](e|es|ed|ing)|summary\s+of|sum\s+up|tl;?dr|gist(\s+of)?|key\s+points|main\s+points|overview\s+of)\b/i;
// Summarising a named file is served by filesystem.summarize (an extractive, verifiable summary), not by a raw read.
export const isReadRequest = (o: string) =>
  requestedFiles(o).length > 0 && !isTextSearch(o) && !SUMMARIZE.test(o) && (READ_VERB.test(o) || (/\bshow\b/i.test(o) && !META_INTENT.test(o)));

/** Words that make a request possibly about files at all. Only narrows what the model is offered when no facet matched. */
const FS_WORDS = /\b(files?|folders?|director(y|ies)|documents?|docs|documentation|reports?|readme|notes?|paths?|pdfs?|markdown|text|lines?|sections?|contents?|occurrences?|mentions?|mentioned|project|workspace|repo(sitory)?|introduction|summari[sz]e|summary)\b/i;
export const isFileRelevant = (o: string) =>
  FS_WORDS.test(o) || requestedFiles(o).length > 0 || requestedFolders(o).length > 0 || requestedExtensions(o).length > 0;

/**
 * "this report", "the document", "that file", "the latest report"...: a reference to a file the request does not
 * name. The runtime has no reliable record of an earlier file (the native host passes no history), so it asks.
 */
const UNNAMED_REF = /\b(this|that|the|my|our|these|those|its)\s+(?:(?:latest|newest|last|recent|most\s+recent|new|current|main|final|same|above|attached|previous)\s+)?(report|reports|document|documents|doc|file|paper|notes?|readme|article|memo|draft|spreadsheet|write-?up|text)\b/i;

export function readClarification(o: string): string | null {
  if (requestedFiles(o).length > 0 || isTextSearch(o)) return null;
  if (!(READ_VERB.test(o) || SUMMARIZE.test(o) || (META_INTENT.test(o) && !isFileSearch(o)))) return null;
  const m = UNNAMED_REF.exec(o);
  if (!m) return null;
  // "the file .env.local", "the report q3-final.txt": a name IS given (even one no tool may open), so do not ask.
  if (/(^|[\s"'`(])\.?[\w-]*\.[\w][\w.-]*/.test(o.slice(m.index + m[0].length))) return null;
  const noun = m[2]!.toLowerCase().replace(/s$/, "").replace(/^doc$/, "document").replace(/^note$/, "notes").replace(/^text$/, "file");
  return `Which ${noun} do you mean? Please name the file (its file name or path). I won't choose a file for you.`;
}

/** True when a request is about finding, reading or describing files, which the listing tool does not serve. */
/** Summarising a named file or folder (filesystem.summarize). */
export const isSummaryRequest = (o: string) => SUMMARIZE.test(o) && !isTextSearch(o) && (requestedFiles(o).length > 0 || requestedFolders(o).length > 0);
export const isFileOperationRequest = (o: string) => isTextSearch(o) || isFileSearch(o) || isMetadataRequest(o) || isReadRequest(o) || isSummaryRequest(o);

// ── filesystem.search ───────────────────────────────────────────────────────

const GENERIC = new Set(["file", "files", "document", "documents", "doc", "docs", "item", "items", "thing", "things", "everything",
  "anything", "something", "stuff", "one", "ones"]);
const SEARCH_VOCAB = ["find", "search", "locate", "look", "where", "which", "files", "file", "documents", "document", "docs", "doc",
  "latest", "newest", "most", "recent", "recently", "last", "modified", "updated", "changed", "named", "called", "name", "names",
  "with", "my", "our", "authorized", "authorised", "approved", "allowed", "permitted", "project", "directory", "directories",
  "folder", "folders", "workspace", "repo", "repository", "root", "subfolders", "subfolder", "recursive", "recursively", "type",
  "types", "extension", "extensions", "every", "all", "any", "list", "show", "its", "their", "and", "them", "one", "ones"];
const META_VOCAB = ["metadata", "size", "sizes", "big", "large", "how", "when", "was", "created", "creation", "modified",
  "modification", "last", "changed", "updated", "timestamp", "timestamps", "date", "dates", "time", "times", "details",
  "properties", "info", "information", "type", "kind"];

const singular = (w: string) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Words of the request that name files: everything the search vocabulary does not explain. */
export function nameTerms(objective: string): string[] {
  const skip = new Set([...SEARCH_VOCAB, ...META_VOCAB, ...EXT_WORDS, ...GENERIC]);
  for (const f of requestedFolders(objective)) for (const s of f.split("/")) skip.add(s);
  const out: string[] = [];
  for (const w of contentWords(objective)) {
    if (skip.has(w) || w.length < 3) continue;
    const s = singular(w);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

interface SearchFacetData { extension: string | null; query: string | null; latest: boolean; folders: string[] }

const sameExt = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/^\./, "").toLowerCase() === (b ?? "").replace(/^\./, "").toLowerCase();

function searchConsistency(input: { query?: string; extension?: string; sort?: string; path?: string }, objective: string): GroundingVerdict {
  const exts = requestedExtensions(objective);
  const terms = nameTerms(objective);
  const folders = requestedFolders(objective);
  const wantedQuery = terms.length ? terms.join(" ") : null;
  if (exts.length ? !exts.some((e) => sameExt(e, input.extension)) : !!input.extension) {
    return contradicted(exts.length ? `the request asks for ${exts.map((e) => "." + e).join(" or ")} files` : "the request names no file type; omit extension");
  }
  const givenQuery = input.query ? input.query.toLowerCase() : null;
  if (givenQuery !== wantedQuery) {
    return contradicted(wantedQuery ? `the file name the request asks for is "${wantedQuery}"` : "the request names no file name; omit query");
  }
  if (LATEST.test(objective) && input.sort !== "modified") return contradicted("the request asks for the latest file; sort by modified");
  if (folders.length && !folders.includes(norm(input.path ?? "."))) return contradicted(`the request names the folder ${folders.join(" or ")}`);
  return grounded("the search matches what the request names");
}

export const searchRequestCheck: ToolRequestCheck<{ query?: string; extension?: string; sort?: string; path?: string }, {
  query: string | null; extension: string | null; sort: string; stoppedAt: string; totalMatches: number;
  matches: { size: number; modified: string; created: string }[];
}> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    if (!isFileSearch(objective)) return {};
    const exts = requestedExtensions(objective);
    const terms = nameTerms(objective);
    const folders = requestedFolders(objective);
    return {
      extension: exts.length ? { kind: "enum", values: exts, optional: false } : { kind: "forbidden", reason: "the request names no file type" },
      query: terms.length ? { kind: "enum", values: [terms.join(" ")], optional: false, compare: "path" } : { kind: "forbidden", reason: "the request names no file name" },
      sort: LATEST.test(objective) ? { kind: "enum", values: ["modified"], optional: false } : { kind: "forbidden", reason: "no ordering is asked for" },
      path: folders.length ? { kind: "enum", values: folders, optional: false, compare: "path" }
        : ROOTISH.test(objective) ? { kind: "enum", values: ["."], optional: true, compare: "path" }
        : { kind: "forbidden", reason: "no folder is named; the whole workspace is searched" },
    };
  },
  relevant: isFileRelevant,
  facets(objective) {
    if (!isFileSearch(objective)) return [];
    const exts = requestedExtensions(objective);
    const terms = nameTerms(objective);
    const latest = LATEST.test(objective);
    const query = terms.length ? terms.join(" ") : null;
    const folders = requestedFolders(objective);
    const facets: RequestFacet[] = (exts.length ? exts : [null]).map((ext) => ({
      id: `search:${ext ?? "*"}:${query ?? "*"}${latest ? ":latest" : ""}`,
      tool: "filesystem.search",
      description: `find ${latest ? "the latest " : ""}${ext ? `.${ext} ` : ""}files${query ? ` named like "${query}"` : ""}`,
      data: { extension: ext, query, latest, folders } satisfies SearchFacetData,
    }));
    if (META_INTENT.test(objective)) {
      facets.push({ id: `search-meta:${query ?? "*"}`, tool: "filesystem.search", description: "show the metadata of the files found", data: { extension: exts[0] ?? null, query, latest, folders } });
    }
    return facets;
  },
  ground(input, objective) {
    if (!isFileSearch(objective)) return ungrounded("the request does not ask to find files");
    return searchConsistency(input, objective);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    if (!outcome.ok || !o || !Array.isArray(o.matches)) return false;
    const d = facet.data as SearchFacetData;
    if (!sameExt(d.extension, input.extension) || (d.query ?? null) !== (input.query?.toLowerCase() ?? null)) return false;
    if (d.folders.length && !d.folders.includes(norm(input.path ?? "."))) return false;
    // Fail-closed: an incomplete walk cannot answer "find all" or "the latest".
    if (o.stoppedAt !== "complete") return false;
    if (d.latest) { if (input.sort !== "modified") return false; }
    else if (o.matches.length !== o.totalMatches) return false;
    if (facet.id.startsWith("search-meta:")) return o.matches.every((m) => typeof m.size === "number" && !!m.modified && !!m.created);
    return true;
  },
  vocabulary(objective) {
    const extras = META_INTENT.test(objective) ? META_VOCAB : [];
    return [...SEARCH_VOCAB, ...extras, ...EXT_WORDS, ...requestedExtensions(objective), ...nameTerms(objective),
      ...contentWords(objective).filter((w) => nameTerms(objective).includes(singular(w))),
      ...requestedFolders(objective).flatMap((f) => f.split("/"))];
  },
};

// ── filesystem.metadata ─────────────────────────────────────────────────────

/** Every word the request's file names contribute, split the same way contentWords splits the request ("q3.md" gives "q", "md"). */
const fileWords = (files: string[]) => files
  .flatMap((f) => f.split(/[\\/]+/))
  .flatMap((seg) => [...seg.split(/[.:_ -]+/), ...contentWords(seg)])
  .map((w) => w.toLowerCase())
  .filter(Boolean);
const matchesNamed = (outputPath: string, named: string) => {
  const o = norm(outputPath);
  const n = norm(named);
  return o === n || o.endsWith("/" + n) || (!n.includes("/") && baseName(o) === n) || /^[a-z]:\//.test(n);
};

export const metadataRequestCheck: ToolRequestCheck<{ path: string }, { path: string; canonicalPath: string; size: number | null; modified: string; created: string }> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    // The model never chooses which file to describe: only files the request names.
    const files = requestedFiles(objective);
    if (files.length === 0) return { path: { kind: "forbidden", reason: "the request names no file" } };
    return { path: { kind: "enum", values: files, optional: false, compare: "path" } };
  },
  relevant: isFileRelevant,
  facets(objective) {
    if (!isMetadataRequest(objective)) return [];
    return requestedFiles(objective).map((f) => ({ id: `meta:${f}`, tool: "filesystem.metadata", description: `describe ${f}`, data: f }));
  },
  ground(input, objective) {
    if (!isMetadataRequest(objective)) return ungrounded("the request does not ask about a named file's details");
    const files = requestedFiles(objective);
    return files.includes(norm(input.path)) ? grounded(`${input.path} is named in the request`) : contradicted(`the request names ${files.join(", ")}`);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    return outcome.ok && !!o && norm(input.path) === facet.data && matchesNamed(o.path, facet.data as string) && !!o.modified && !!o.created;
  },
  vocabulary(objective) {
    return [...META_VOCAB, "show", "file", "folder", "of", "its", "the", "about", "describe", ...fileWords(requestedFiles(objective))];
  },
};

// ── filesystem.read ─────────────────────────────────────────────────────────

const READ_VOCAB = ["read", "open", "show", "display", "print", "view", "contents", "content", "text", "file", "document", "report",
  "section", "part", "lines", "line", "first", "from", "to", "through", "until", "of", "says", "say", "whole", "full", "entire", "out",
  ...Object.keys(SECTION_ALIASES)];

export const readRequestCheck: ToolRequestCheck<{ path: string; startLine?: number; endLine?: number; heading?: string }, {
  path: string; startLine: number; endLine: number; totalLines: number; section: string | null; truncated: boolean; text: string;
}> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    // The model never chooses which file to read: not by recency, order or preference. Only files the request names.
    const files = requestedFiles(objective);
    if (files.length === 0) return { path: { kind: "forbidden", reason: "the request names no file" } };
    if (!isReadRequest(objective)) return { path: { kind: "enum", values: files, optional: false, compare: "path" } };
    const section = requestedSection(objective);
    const lines = requestedLines(objective);
    const out: Record<string, ArgumentDomain> = {
      path: { kind: "enum", values: requestedFiles(objective), optional: false, compare: "path" },
      heading: section ? { kind: "enum", values: [section], optional: false } : { kind: "forbidden", reason: "the request names no section" },
    };
    if (!lines) {
      out.startLine = { kind: "forbidden", reason: "the request names no line range" };
      out.endLine = { kind: "forbidden", reason: "the request names no line range" };
    }
    return out;
  },
  relevant: isFileRelevant,
  clarify: readClarification,
  facets(objective) {
    if (!isReadRequest(objective)) return [];
    const section = requestedSection(objective);
    const lines = requestedLines(objective);
    return requestedFiles(objective).map((f) => ({
      id: `read:${f}${section ? `#${section}` : ""}${lines ? `@${lines.start}-${lines.end}` : ""}`,
      tool: "filesystem.read",
      description: `read ${section ? `the ${section} of ` : lines ? `lines ${lines.start}–${lines.end} of ` : ""}${f}`,
      data: { file: f, section, lines },
    }));
  },
  ground(input, objective) {
    if (!isReadRequest(objective)) return ungrounded("the request does not ask to read a named file");
    const files = requestedFiles(objective);
    if (!files.includes(norm(input.path))) return contradicted(`the request names ${files.join(", ")}`);
    const section = requestedSection(objective);
    if (section && (input.heading ?? "").toLowerCase() !== section.toLowerCase()) return contradicted(`the request asks for the "${section}" section`);
    if (!section && input.heading) return contradicted("the request names no section; omit heading");
    const lines = requestedLines(objective);
    if (lines && (input.startLine !== lines.start || input.endLine !== lines.end)) return contradicted(`the request asks for lines ${lines.start}–${lines.end}`);
    if (!lines && (input.startLine !== undefined || input.endLine !== undefined)) return contradicted("the request names no line range");
    return grounded(`${input.path} is named in the request`);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    const d = facet.data as { file: string; section: string | null; lines: { start: number; end: number } | null };
    if (!outcome.ok || !o || norm(input.path) !== d.file || !matchesNamed(o.path, d.file)) return false;
    if (o.truncated) return false; // part of what was asked was not returned
    if (d.section && !(o.section ?? "").toLowerCase().replace(/^\s*\d+(\.\d+)*\.?\s*/, "").startsWith(d.section.toLowerCase())) return false;
    // A range that runs past the end of the file is served by reading to the last line.
    if (d.lines && (o.startLine !== d.lines.start || (o.endLine !== d.lines.end && o.endLine !== o.totalLines))) return false;
    return true;
  },
  vocabulary(objective) {
    return [...READ_VOCAB, ...fileWords(requestedFiles(objective)), ...(requestedSection(objective)?.toLowerCase().split(/\s+/) ?? [])];
  },
};

// ── filesystem.find_text ────────────────────────────────────────────────────

const TEXT_VOCAB = ["find", "search", "locate", "look", "where", "every", "all", "each", "any", "occurrence", "occurrences", "instance",
  "instances", "mention", "mentions", "mentioned", "mentioning", "term", "word", "phrase", "string", "keyword", "text", "containing",
  "contain", "contains", "appear", "appears", "used", "use", "uses", "reference", "references", "referencing", "line", "lines",
  "inside", "within", "across", "project", "documentation", "docs", "doc", "files", "file", "folder", "folders", "workspace", "my",
  "our", "authorized", "approved", "grep"];
const DOC_FOLDERS = ["docs", "doc", "documentation"];

function textPaths(objective: string): { values: string[]; optional: boolean } | null {
  const folders = requestedFolders(objective);
  if (folders.length) return { values: folders, optional: false };
  if (DOCS_WORDS.test(objective)) return { values: [...DOC_FOLDERS, "."], optional: true };
  return null;
}

export const findTextRequestCheck: ToolRequestCheck<{ query: string; path?: string; extension?: string }, {
  query: string; stoppedAt: string; filesScanned: number;
}> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    if (!isTextSearch(objective)) {
      // The model never chooses what to search for: only a term the request names.
      const named = textQuery(objective);
      return { query: named ? { kind: "enum", values: [named], optional: false } : { kind: "forbidden", reason: "the request names no search term" } };
    }
    const q = textQuery(objective)!;
    const paths = textPaths(objective);
    const exts = requestedExtensions(objective);
    return {
      query: { kind: "enum", values: [q], optional: false },
      path: paths ? { kind: "enum", values: paths.values, optional: paths.optional, compare: "path" } : { kind: "forbidden", reason: "no folder is named; the whole workspace is searched" },
      extension: exts.length ? { kind: "enum", values: exts, optional: false } : { kind: "forbidden", reason: "the request names no file type" },
    };
  },
  relevant: isFileRelevant,
  facets(objective) {
    if (!isTextSearch(objective)) return [];
    const q = textQuery(objective)!;
    return [{ id: `text:${q.toLowerCase()}`, tool: "filesystem.find_text", description: `find every line containing "${q}"`, data: q.toLowerCase() }];
  },
  ground(input, objective) {
    if (!isTextSearch(objective)) return ungrounded("the request does not ask to search inside files");
    const q = textQuery(objective)!;
    if (input.query.toLowerCase() !== q.toLowerCase()) return contradicted(`the request searches for "${q}"`);
    const paths = textPaths(objective);
    if (input.path !== undefined && input.path !== "" && !(paths?.values ?? ["."]).includes(norm(input.path))) {
      return contradicted(`the request names ${paths ? paths.values.join(" or ") : "no folder (the whole workspace)"}`);
    }
    if (paths && !paths.optional && (input.path === undefined || input.path === "")) return contradicted(`the request names the folder ${paths.values.join(" or ")}`);
    const exts = requestedExtensions(objective);
    if (exts.length ? !exts.some((e) => sameExt(e, input.extension)) : !!input.extension) return contradicted("the file type does not match the request");
    return grounded(`searching for "${q}" as the request asks`);
  },
  satisfies(facet, input, outcome) {
    const o = outcome.output;
    // Fail-closed: a search that stopped early cannot answer "every occurrence".
    return outcome.ok && !!o && o.query.toLowerCase() === facet.data && input.query.toLowerCase() === facet.data && o.stoppedAt === "complete" && o.filesScanned > 0;
  },
  vocabulary(objective) {
    const q = textQuery(objective) ?? "";
    return [...TEXT_VOCAB, ...EXT_WORDS, ...q.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean),
      ...requestedFolders(objective).flatMap((f) => f.split("/"))];
  },
};

/** For tests and diagnostics: the facet data shapes are internal, so expose the outcome type loosely. */
export type FsOutcome = ToolOutcome<unknown>;
