// ─────────────────────────────────────────────────────────────────────────────
// Read-only file access policy for the filesystem tools (Phase 7A).
//
// Everything a filesystem tool touches goes through here:
//   - Roots: the workspace root, plus directories the user configured explicitly
//     (DASK_FS_ROOTS). Nothing else is ever reachable, and a bad root is dropped,
//     never widened.
//   - Paths: the model's argument is validated as text first (no UNC, device,
//     stream or traversal forms), then resolved to its canonical form by the OS
//     (junctions, symbolic links and short names included). The canonical path must
//     still be inside the same root.
//   - Content: secret-looking and dependency/VCS paths are invisible; only known
//     text types are read; binary content is refused; well-known credential formats
//     are redacted from returned text.
//
// Read-only by construction: this module opens files for reading and lists
// directories. It has no write, move, delete or execute code path.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { promises as fs, type Stats } from "node:fs";

// ── Roots ────────────────────────────────────────────────────────────────────

export interface FileRoot {
  /** Short name shown in results: "workspace" for the first root, the folder name otherwise. */
  label: string;
  /** Canonical absolute path (realpath), so containment checks compare like with like. */
  path: string;
}

export interface FileAccessLimits {
  /** Directory levels below the starting folder that a walk enters. */
  maxDepth: number;
  /** Directory entries a single walk may visit, files and folders together. */
  maxEntriesVisited: number;
  /** Largest file `filesystem.read` will open. */
  maxReadFileBytes: number;
  /** Largest file `filesystem.find_text` will scan; larger ones are skipped and counted. */
  maxScanFileBytes: number;
  /** Text files `filesystem.find_text` scans at most. */
  maxScanFiles: number;
  /** Total bytes `filesystem.find_text` reads at most. */
  maxScanTotalBytes: number;
}

export const DEFAULT_FILE_LIMITS: FileAccessLimits = Object.freeze({
  maxDepth: 12,
  maxEntriesVisited: 50_000,
  maxReadFileBytes: 4 * 1024 * 1024,
  maxScanFileBytes: 1024 * 1024,
  maxScanFiles: 2_000,
  maxScanTotalBytes: 64 * 1024 * 1024,
});

/** Never allowed as a root, whatever the configuration says: too broad, or the OS itself. */
function isForbiddenRoot(p: string): string | null {
  const n = p.replace(/[\\/]+$/, "").toLowerCase();
  if (/^[a-z]:$/.test(n)) return "a whole drive";
  const sysRoot = (process.env.SystemRoot ?? "C:\\Windows").replace(/[\\/]+$/, "").toLowerCase();
  if (n === sysRoot || n.startsWith(sysRoot + "\\")) return "the Windows system folder";
  for (const v of ["ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
    const d = process.env[v]?.replace(/[\\/]+$/, "").toLowerCase();
    if (d && (n === d || n.startsWith(d + "\\"))) return `the ${v} folder`;
  }
  const profile = (process.env.USERPROFILE ?? "").replace(/[\\/]+$/, "").toLowerCase();
  if (profile && n === profile) return "the whole user profile (name a folder inside it instead)";
  return null;
}

export interface ResolvedRoots { roots: FileRoot[]; rejected: { path: string; reason: string }[] }

/**
 * Canonicalises the configured roots. The workspace root comes first and is labelled
 * "workspace". Extra roots must be absolute, existing directories that are not drives,
 * the OS or the whole profile; anything else is reported and dropped.
 */
export async function resolveRoots(workspaceRoot: string, extraRoots: readonly string[] = []): Promise<ResolvedRoots> {
  const roots: FileRoot[] = [];
  const rejected: { path: string; reason: string }[] = [];
  const add = async (raw: string, label: string | null) => {
    if (!path.isAbsolute(raw)) { rejected.push({ path: raw, reason: "not an absolute path" }); return; }
    let real: string;
    try {
      real = await fs.realpath(raw);
      if (!(await fs.stat(real)).isDirectory()) { rejected.push({ path: raw, reason: "not a directory" }); return; }
    } catch {
      rejected.push({ path: raw, reason: "does not exist" });
      return;
    }
    const forbidden = isForbiddenRoot(real);
    if (forbidden) { rejected.push({ path: raw, reason: `refused: ${forbidden}` }); return; }
    if (roots.some((r) => samePath(r.path, real))) return;
    let name = label ?? path.basename(real);
    while (roots.some((r) => r.label.toLowerCase() === name.toLowerCase())) name += "_";
    roots.push({ label: name, path: real });
  };
  await add(path.resolve(workspaceRoot), "workspace");
  for (const r of extraRoots) await add(r.trim(), null);
  return { roots, rejected };
}

/** DASK_FS_ROOTS: extra roots, separated by ";" (Windows path delimiter). */
export function rootsFromEnv(value: string | undefined): string[] {
  return (value ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

// ── Names that are never shown, entered or read ─────────────────────────────

const HIDDEN_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", ".next", ".venv", "venv", "__pycache__", ".nuget", ".xwin-sdk", ".xwin-cache",
  ".dotnet_home", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "$recycle.bin", "system volume information",
]);

const SECRET_FILE = [
  /^\.env(\..*)?$/i,                              // .env, .env.local, ...
  /\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|kdb|keychain|gpg|asc|der|crt|cer|csr|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(\.npmrc|\.pypirc|\.netrc|_netrc|\.pgpass|\.git-credentials|\.htpasswd|\.dockercfg|known_hosts|authorized_keys)$/i,
  /^credentials(\..*)?$/i,
  /(^|[._-])(secrets?|passwords?|tokens?|api[_-]?keys?)([._-]|$)/i,
  /^(login data|cookies|web data)$/i,              // browser credential and cookie stores
];

export function isHiddenDir(name: string): boolean {
  return HIDDEN_DIRS.has(name.toLowerCase());
}

export function isSecretName(name: string): boolean {
  return SECRET_FILE.some((re) => re.test(name));
}

// ── Text types ───────────────────────────────────────────────────────────────

/** Extensions read and searched as text. Anything else can be found and described, never read. */
export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "adoc", "log", "csv", "tsv",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
  "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "cs", "java", "kt", "go", "c", "h", "cpp", "hpp",
  "sh", "ps1", "psm1", "bat", "cmd", "sql", "rb", "php", "swift", "lua", "r",
]);

export function extensionOf(name: string): string {
  const ext = path.extname(name);
  return ext ? ext.slice(1).toLowerCase() : "";
}

export function kindOf(name: string, isDirectory: boolean): string {
  if (isDirectory) return "directory";
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "document";
  if (["xls", "xlsx", "ods"].includes(ext)) return "spreadsheet";
  if (["ppt", "pptx", "odp"].includes(ext)) return "presentation";
  if (["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff"].includes(ext)) return "image";
  if (["zip", "7z", "rar", "tar", "gz", "tgz"].includes(ext)) return "archive";
  if (["exe", "dll", "msi", "sys", "bin", "so", "dylib"].includes(ext)) return "binary";
  return "other";
}

// ── Path validation ─────────────────────────────────────────────────────────

export type PathCheck =
  | { ok: true; root: FileRoot; canonical: string; rel: string; stats: Stats }
  | { ok: false; code: PathErrorCode; error: string };

export type PathErrorCode = "invalid_path" | "outside_roots" | "hidden" | "not_found" | "permission_denied" | "ambiguous";

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Validates the model's path as text, before anything touches the disk. Rejects every
 * form that can name something other than a plain file under a root.
 */
export function checkPathText(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return "empty path";
  if (input.length > 512) return "path too long";
  if (/[\u0000-\u001f]/.test(input)) return "control characters in path";
  if (/[<>"|?*]/.test(input)) return "wildcard or reserved characters in path";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return "URLs are not paths";
  if (/^[\\/]{2}/.test(input)) return "network, device and extended-length paths are not allowed";
  const drive = /^[a-zA-Z]:/.test(input);
  if (input.indexOf(":", drive ? 2 : 0) !== -1) return "alternate data streams and device paths are not allowed";
  if (drive && !/^[a-zA-Z]:[\\/]/.test(input)) return "drive-relative paths are not allowed";
  for (const seg of input.split(/[\\/]+/).filter(Boolean)) {
    if (seg === "..") return "\"..\" is not allowed";
    if (seg !== "." && /[. ]$/.test(seg)) return "path segments may not end with a dot or space";
    if (RESERVED.test(seg)) return `"${seg}" is a reserved device name`;
  }
  return null;
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Relative path of `p` under `root`, or null when it is not inside. Case-insensitive, as Windows is. */
export function relativeInside(root: string, p: string): string | null {
  const rel = path.relative(root.toLowerCase(), p.toLowerCase());
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Rebuild from the original casing.
  return path.relative(root, p);
}

/** Hidden or secret segment anywhere in a path relative to its root. */
export function blockedSegment(rel: string): string | null {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (isHiddenDir(s)) return s;
    if (isSecretName(s)) return s;
  }
  return null;
}

export const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * Resolves a model-supplied path to a canonical file or folder inside a root.
 * Relative paths are relative to the workspace root; absolute paths must lie inside a root.
 * The decision is made on the canonical path the OS reports, so a junction or link that
 * leads outside every root is refused even when its own name is inside one.
 */
export async function resolveInside(roots: readonly FileRoot[], input: string | undefined): Promise<PathCheck> {
  const raw = input === undefined || input === "" ? "." : input;
  const textError = checkPathText(raw);
  if (textError) return { ok: false, code: "invalid_path", error: textError };

  let candidate: string;
  let declaredRoot: FileRoot | undefined;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    candidate = path.resolve(raw);
    declaredRoot = roots.find((r) => relativeInside(r.path, candidate) !== null);
    if (!declaredRoot) return { ok: false, code: "outside_roots", error: "That location is outside the folders D-ASK may read" };
  } else {
    declaredRoot = roots[0];
    if (!declaredRoot) return { ok: false, code: "outside_roots", error: "No readable folders are configured" };
    candidate = path.resolve(declaredRoot.path, raw);
  }
  const declaredRel = relativeInside(declaredRoot.path, candidate);
  if (declaredRel === null) return { ok: false, code: "outside_roots", error: "That location is outside the folders D-ASK may read" };
  if (blockedSegment(declaredRel)) return { ok: false, code: "hidden", error: "That location is excluded (credentials, secrets or system folders)" };

  let canonical: string;
  try {
    canonical = await fs.realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, code: "permission_denied", error: "Permission denied" };
    return { ok: false, code: "not_found", error: "No such file or folder" };
  }
  // The canonical form decides: it must be inside the SAME root, and still not hidden or secret.
  const rel = relativeInside(declaredRoot.path, canonical);
  if (rel === null) return { ok: false, code: "outside_roots", error: "That location resolves outside the folders D-ASK may read (link or junction)" };
  if (blockedSegment(rel)) return { ok: false, code: "hidden", error: "That location is excluded (credentials, secrets or system folders)" };

  let stats: Stats;
  try {
    stats = await fs.stat(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM"
      ? { ok: false, code: "permission_denied", error: "Permission denied" }
      : { ok: false, code: "not_found", error: "No such file or folder" };
  }
  return { ok: true, root: declaredRoot, canonical, rel: toPosix(rel) || ".", stats };
}

// ── Bounded walking ─────────────────────────────────────────────────────────

export interface WalkEntry { canonical: string; rel: string; name: string; isDirectory: boolean; stats: Stats }
export interface WalkSummary { visited: number; skippedLinks: number; skippedHidden: number; unreadableDirs: number; stoppedAt: "complete" | "entry_limit" | "cancelled" }

/**
 * Depth-first, sorted (so results are deterministic), bounded walk under `start`.
 * Never follows symbolic links or junctions: entries that are links, or folders whose
 * canonical path differs from their listed path (any reparse point), are skipped and counted.
 */
export async function walk(
  root: FileRoot,
  start: string,
  opts: { recursive: boolean; maxDepth: number; maxEntries: number; signal: AbortSignal },
  visit: (e: WalkEntry) => Promise<boolean | void> | boolean | void,
): Promise<WalkSummary> {
  const summary: WalkSummary = { visited: 0, skippedLinks: 0, skippedHidden: 0, unreadableDirs: 0, stoppedAt: "complete" };
  const recurse = async (dir: string, depth: number): Promise<boolean> => {
    if (opts.signal.aborted) { summary.stoppedAt = "cancelled"; return false; }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      summary.unreadableDirs++;
      return true;
    }
    dirents.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    for (const d of dirents) {
      if (opts.signal.aborted) { summary.stoppedAt = "cancelled"; return false; }
      if (summary.visited >= opts.maxEntries) { summary.stoppedAt = "entry_limit"; return false; }
      summary.visited++;
      if (d.isSymbolicLink()) { summary.skippedLinks++; continue; }
      const isDir = d.isDirectory();
      if (isDir ? isHiddenDir(d.name) : isSecretName(d.name)) { summary.skippedHidden++; continue; }
      if (!isDir && !d.isFile()) continue;
      const full = path.join(dir, d.name);
      let stats: Stats;
      try { stats = await fs.lstat(full); } catch { continue; }
      if (stats.isSymbolicLink()) { summary.skippedLinks++; continue; }
      if (isDir) {
        // Junctions and other reparse points: their canonical path is not where they are listed.
        let real: string;
        try { real = await fs.realpath(full); } catch { summary.unreadableDirs++; continue; }
        if (!samePath(real, full) || relativeInside(root.path, real) === null) { summary.skippedLinks++; continue; }
      }
      const rel = relativeInside(root.path, full);
      if (rel === null) { summary.skippedLinks++; continue; }
      const keepGoing = await visit({ canonical: full, rel: toPosix(rel), name: d.name, isDirectory: isDir, stats });
      if (keepGoing === false) return false;
      if (isDir && opts.recursive && depth < opts.maxDepth) {
        if (!(await recurse(full, depth + 1))) return false;
      }
    }
    return true;
  };
  await recurse(start, 0);
  return summary;
}

// ── Text decoding ───────────────────────────────────────────────────────────

export type Decoded = { ok: true; text: string; encoding: string } | { ok: false; reason: string };

/**
 * UTF-8 (with or without BOM), UTF-16 LE/BE with BOM, and Windows-1252 for legacy text.
 * Content with NUL bytes (outside UTF-16) or too many control characters is binary.
 */
export function decodeText(buf: Buffer): Decoded {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { ok: true, text: buf.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { ok: true, text: swapped.toString("utf16le"), encoding: "utf-16be" };
  }
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return { ok: false, reason: "binary content" };
  let controls = 0;
  for (const b of sample) if (b < 0x09 || (b > 0x0d && b < 0x20)) controls++;
  if (sample.length > 0 && controls / sample.length > 0.02) return { ok: false, reason: "binary content" };
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: bom ? "utf-8-bom" : "utf-8" };
  } catch {
    try {
      return { ok: true, text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
    } catch {
      return { ok: false, reason: "unsupported text encoding" };
    }
  }
}

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{16,}/g,     // OpenAI, OpenRouter, Anthropic style keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,     // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                           // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                      // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                 // Slack
  /\bgsk_[A-Za-z0-9]{20,}/g,                         // Groq
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
const ASSIGNED_SECRET = /\b((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})\2/gi;

/** Replaces well-known credential formats with [REDACTED]. Heuristic: it reduces exposure, it is not a guarantee. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => { count++; return "[REDACTED]"; });
  out = out.replace(ASSIGNED_SECRET, (_m, lead: string, q: string) => { count++; return `${lead}${q}[REDACTED]${q}`; });
  return { text: out, count };
}

/** Splits text into lines without their terminators. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
