// ─────────────────────────────────────────────────────────────────────────────
// File organisation (agent side). The model chooses NOTHING about what moves where:
//   - the folder and the rule ("by type" / "by month" / "by extension") come from the request (argument domains);
//   - the plan is computed here, deterministically, from the folder's own top-level files (FileAccess: roots, no links,
//     no hidden or secret names) — subfolders are never entered and nothing is renamed;
//   - the daemon is the authority: files.organize validates everything again, shows the EXACT moves for approval,
//     performs them (never overwriting), verifies them and keeps an undo journal. files.undo_organize reverses the most
//     recent one, approved the same way.
// filesystem.plan_organize only previews the plan (read-only, no daemon call).
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolRequestCheck, ToolSpec } from "../types";
import { extensionOf, walk } from "./fileAccess";
import type { FileAccess } from "./filesystem";
import type { DesktopBridge, DesktopReply } from "./desktop";
import { requestedFolders } from "./filesystemChecks";

export type OrganizeRule = "type" | "month" | "extension";
export interface PlannedMove { name: string; into: string }
export interface OrganizePlan { folder: string; canonical: string; rule: OrganizeRule; moves: PlannedMove[]; batch: PlannedMove[]; remaining: number; leftInPlace: { name: string; why: string }[] }

/** Same limits as the daemon (FileOrganizeRequestService): ≤ 40 moves and a move list short enough to show on the card. */
export const MAX_BATCH = 40;
export const MAX_BATCH_TEXT = 1900;
const ARROW = " → ";
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.,'()&+@#!$%=~[\]{}-]{0,119}$/u;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const TYPE_FOLDERS: [string, string[]][] = [
  ["Documents", ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "tex", "epub"]],
  ["Spreadsheets", ["xls", "xlsx", "xlsm", "ods", "csv", "tsv"]],
  ["Presentations", ["ppt", "pptx", "odp", "key"]],
  ["Images", ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "heic", "tif", "tiff", "ico", "raw"]],
  ["Audio", ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]],
  ["Video", ["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v"]],
  ["Archives", ["zip", "7z", "rar", "tar", "gz", "bz2", "xz"]],
  ["Installers", ["exe", "msi", "msix", "appx"]],
  ["Code", ["js", "ts", "py", "cs", "java", "cpp", "c", "h", "rs", "go", "rb", "php", "ps1", "sh", "json", "xml", "yml", "yaml", "html", "css", "sql"]],
];
export function typeFolder(name: string): string | null {
  const ext = extensionOf(name);
  return TYPE_FOLDERS.find(([, exts]) => exts.includes(ext))?.[0] ?? null;
}

export const movesText = (moves: PlannedMove[]) => moves.map((m) => `${m.name}${ARROW}${m.into}\\`).join("\n");

/** The plan for one folder: its top-level files only; deterministic (sorted by name); split into a first batch that fits. */
export async function planOrganize(access: FileAccess, folder: string, rule: OrganizeRule, signal: AbortSignal): Promise<{ ok: true; plan: OrganizePlan } | { ok: false; error: string }> {
  const r = await access.locate(folder, signal);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.stats.isDirectory()) return { ok: false, error: `${folder} is a file, not a folder` };
  const files: { name: string; mtime: number }[] = [];
  const sub = new Set<string>();
  const w = await walk(r.root, r.canonical, { recursive: false, maxDepth: 0, maxEntries: 5_000, signal }, (e) => {
    if (e.isDirectory) sub.add(e.name.toLowerCase()); else files.push({ name: e.name, mtime: e.stats.mtimeMs });
  });
  if (w.stoppedAt === "cancelled") return { ok: false, error: "Cancelled" };
  if (w.stoppedAt !== "complete") return { ok: false, error: "The folder has too many entries to plan safely" };
  const moves: PlannedMove[] = [];
  const left: { name: string; why: string }[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!SAFE_NAME.test(f.name) || RESERVED.test(f.name) || /[. ]$/.test(f.name)) { left.push({ name: f.name, why: "a name the daemon does not move" }); continue; }
    const into = rule === "type" ? typeFolder(f.name)
      : rule === "extension" ? (extensionOf(f.name) ? extensionOf(f.name).toUpperCase() : null)
      : new Date(f.mtime).toISOString().slice(0, 7);
    if (!into) { left.push({ name: f.name, why: rule === "type" ? "no known type" : "no extension" }); continue; }
    if (sub.has(f.name.toLowerCase()) || into.toLowerCase() === f.name.toLowerCase()) { left.push({ name: f.name, why: "clashes with a folder name" }); continue; }
    moves.push({ name: f.name, into });
  }
  const batch: PlannedMove[] = [];
  for (const m of moves) {
    if (batch.length >= MAX_BATCH || movesText([...batch, m]).length > MAX_BATCH_TEXT) break;
    batch.push(m);
  }
  return { ok: true, plan: { folder: r.rel, canonical: r.canonical, rule, moves, batch, remaining: moves.length - batch.length, leftInPlace: left } };
}

// ── Request understanding ─────────────────────────────────────────────────────

const ORGANIZE = /\b(organi[sz]e|sort|tidy(\s+up)?|clean\s+up|arrange|group)\b/i;
const PREVIEW = /\b(preview|show\s+(me\s+)?how|what\s+would|how\s+would|plan\s+(to|how)|dry[\s-]?run|without\s+moving|suggest)\b/i;
const UNDO = /\b(undo|revert|reverse|put\s+(them|it|everything)\s+back)\b.*\b(organi[sz]|sort|tid|mov|arrang|clean)/i;
export function organizeRule(o: string): OrganizeRule | null {
  if (/\bby\s+(file\s+)?(type|kind|category)\b|\binto\s+(folders\s+by\s+)?type\b/i.test(o)) return "type";
  if (/\bby\s+(month|date|modified\s+date|year\s+and\s+month)\b/i.test(o)) return "month";
  if (/\bby\s+(file\s+)?extension\b/i.test(o)) return "extension";
  return null;
}
/** The folder an organise request names: an absolute path, a slash path, or "the X folder". */
export function organizeFolders(o: string): string[] {
  const abs = [...o.matchAll(/["“]([A-Za-z]:\\[^"”]+)["”]|(?:^|\s)([A-Za-z]:\\[^\s"]+)/g)].map((m) => (m[1] ?? m[2])!.replace(/[\\.]+$/, ""));
  return abs.length ? abs : requestedFolders(o);
}
export const isUndoOrganize = (o: string) => UNDO.test(o);
export const isOrganizeRequest = (o: string) => !isUndoOrganize(o) && ORGANIZE.test(o) && /\b(files?|folders?|director(y|ies)|downloads|desktop|documents)\b/i.test(o) && organizeFolders(o).length > 0;
export const isOrganizePreview = (o: string) => isOrganizeRequest(o) && PREVIEW.test(o);

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const pnorm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

interface OrgArgs { folder?: string; by?: OrganizeRule }
const VOCAB = ["organise", "organize", "sort", "tidy", "up", "clean", "arrange", "group", "the", "my", "files", "file", "in", "inside", "of", "folder",
  "folders", "directory", "subfolders", "into", "by", "type", "types", "kind", "category", "month", "date", "modified", "year", "and", "extension",
  "please", "preview", "show", "me", "how", "what", "would", "you", "plan", "dry", "run", "without", "moving", "suggest", "undo", "revert", "reverse",
  "put", "them", "back", "last", "organisation", "organization", "sorting", "moves", "move", "a", "it", "everything", "first"];

function organizeCheck(mode: "do" | "preview"): ToolRequestCheck<OrgArgs, any> {
  const mine = (o: string) => (mode === "preview" ? isOrganizePreview(o) : isOrganizeRequest(o) && !isOrganizePreview(o));
  const tool = mode === "preview" ? "filesystem.plan_organize" : "filesystem.organize";
  return {
    argumentDomains(o): Record<string, ArgumentDomain> {
      if (!mine(o)) return { folder: { kind: "forbidden", reason: "the request does not ask to organise a named folder" } };
      const rule = organizeRule(o);
      return {
        folder: { kind: "enum", values: organizeFolders(o), optional: false, compare: "path" },
        by: rule ? { kind: "enum", values: [rule], optional: false } : { kind: "forbidden", reason: "the request names no rule" },
      };
    },
    relevant: (o) => ORGANIZE.test(o),
    clarify: (o) => (mine(o) && !organizeRule(o) ? "How should I organise it: by type (Documents, Images, …), by month (2026-11, …), or by extension (PDF, JPG, …)?" : null),
    facets(o): RequestFacet[] {
      if (!mine(o) || !organizeRule(o)) return [];
      return organizeFolders(o).map((f) => ({ id: `${mode === "preview" ? "plan-organize" : "organize"}:${pnorm(f)}:${organizeRule(o)}`, tool,
        description: `${mode === "preview" ? "preview organising" : "organise"} ${f} by ${organizeRule(o)}`, data: { folder: pnorm(f), rule: organizeRule(o) } }));
    },
    ground(input, o) {
      if (!mine(o)) return ungrounded("the request does not ask for this");
      if (!organizeFolders(o).map(pnorm).includes(pnorm(input.folder ?? ""))) return contradicted(`the request names ${organizeFolders(o).join(", ")}`);
      if (input.by !== organizeRule(o)) return contradicted(`the request asks to organise by ${organizeRule(o) ?? "(not said)"}`);
      return grounded("folder and rule are taken from the request");
    },
    satisfies(facet, input, outcome) {
      const d = facet.data as { folder: string; rule: OrganizeRule };
      const out = outcome.output;
      if (!outcome.ok || !out || pnorm(input.folder ?? "") !== d.folder || input.by !== d.rule) return false;
      // Organising is satisfied only when the daemon performed AND verified every move and nothing of the plan remains.
      return mode === "preview" ? Array.isArray(out.moves) : out.executed === true && out.verified === true && out.remaining === 0;
    },
    vocabulary: (o) => [...VOCAB, ...organizeFolders(o).flatMap((f) => [...f.split(/[\\/:._ -]+/), ...contentWords(f)]).map((w) => w.toLowerCase())],
  };
}

const undoCheck: ToolRequestCheck<Record<string, never>, any> = {
  argumentDomains: () => ({}),
  relevant: (o) => isUndoOrganize(o),
  facets: (o) => (isUndoOrganize(o) ? [{ id: "undo-organize", tool: "filesystem.undo_organize", description: "undo the last file organisation", data: null }] : []),
  ground: (_i, o) => (isUndoOrganize(o) ? grounded("the request asks to undo the last organisation") : ungrounded("the request does not ask to undo an organisation")),
  satisfies: (_f, _i, outcome) => outcome.ok && outcome.output?.executed === true && outcome.output?.verified === true,
  vocabulary: () => VOCAB,
};

// ── Copy / rename (one file per request; the daemon validates, shows the card, journals, verifies) ─────────────────

const PATH_RE = String.raw`(?:"([A-Za-z]:\\[^"]+)"|“([A-Za-z]:\\[^”]+)”|([A-Za-z]:\\\S+))`;
const NAME_RE = String.raw`(?:"([^"\\/:*?<>|]{1,120})"|([^\s"\\/:*?<>|]{1,120}))`;
const COPY_RE = new RegExp(String.raw`^\s*(?:please\s+)?(?:copy|duplicate|make\s+a\s+copy\s+of)\s+(?:the\s+file\s+)?${PATH_RE}(?:\s+(?:to|into)\s+(?:the\s+folder\s+)?${PATH_RE})?(?:\s+(?:as|called|named)\s+${NAME_RE})?\s*[.!]?\s*$`, "i");
const RENAME_RE = new RegExp(String.raw`^\s*(?:please\s+)?rename\s+(?:the\s+file\s+)?${PATH_RE}\s+(?:to|as)\s+${NAME_RE}\s*[.!]?\s*$`, "i");
const UNDO_CR = /^\s*(?:please\s+)?(?:undo|revert|reverse)\s+(?:the\s+|my\s+)?(?:last\s+|previous\s+)?(?:file\s+|folder\s+)?(copy|rename|renaming|move)\s*[.!]?\s*$/i;
// "Move D:\a\report.pdf to D:\b" / "move the folder D:\a\Project to D:\b and call it Project 2025": ONE file or folder, two absolute paths.
const MOVE_RE = new RegExp(String.raw`^\s*(?:please\s+)?move\s+(?:the\s+(?:file|folder)\s+)?${PATH_RE}\s+(?:to|into)\s+(?:the\s+folder\s+)?${PATH_RE}(?:\s+(?:and\s+(?:call|name)\s+it|as|named|called)\s+${NAME_RE})?\s*[.!]?\s*$`, "i");
const pick = (m: RegExpExecArray, i: number) => (m[i] ?? m[i + 1] ?? m[i + 2])?.trim().replace(/[\\.]+$/, "") || null;

export interface CopyArgs { path: string; toFolder?: string; newName?: string }
export interface RenameArgs { path: string; newName: string }
export function requestedCopy(o: string): CopyArgs | null {
  const m = COPY_RE.exec(o);
  if (!m) return null;
  const path = pick(m, 1)!, toFolder = pick(m, 4), newName = (m[7] ?? m[8])?.trim() || null;
  if (newName && (!SAFE_NAME.test(newName) || RESERVED.test(newName))) return null;
  return { path, ...(toFolder ? { toFolder } : {}), ...(newName ? { newName } : {}) };
}
export function requestedRename(o: string): RenameArgs | null {
  const m = RENAME_RE.exec(o);
  if (!m) return null;
  const newName = (m[4] ?? m[5])?.trim();
  if (!newName || !SAFE_NAME.test(newName) || RESERVED.test(newName) || /[. ]$/.test(newName)) return null;
  return { path: pick(m, 1)!, newName };
}
export const isUndoCopyRename = (o: string) => UNDO_CR.test(o);
export interface MoveArgs { path: string; toFolder: string; newName?: string }
export function requestedMove(o: string): MoveArgs | null {
  const m = MOVE_RE.exec(o);
  if (!m) return null;
  const path = pick(m, 1), toFolder = pick(m, 4), newName = (m[7] ?? m[8])?.trim() || null;
  if (!path || !toFolder) return null;
  if (newName && (!SAFE_NAME.test(newName) || RESERVED.test(newName))) return null;
  return { path, toFolder, ...(newName ? { newName } : {}) };
}

const CR_VOCAB = ["copy", "duplicate", "make", "a", "of", "the", "file", "to", "into", "folder", "as", "called", "named", "rename", "please", "undo", "revert", "reverse", "last", "previous", "my", "renaming"];
const words = (s: string) => s.split(/[\\/:._ "-]+/).filter(Boolean).map((w) => w.toLowerCase());

const copyCheck: ToolRequestCheck<CopyArgs, any> = {
  argumentDomains(o): Record<string, ArgumentDomain> {
    const r = requestedCopy(o);
    if (!r) return { path: { kind: "forbidden", reason: "the request does not ask to copy a named file" } };
    return {
      path: { kind: "enum", values: [r.path], optional: false, compare: "path" },
      toFolder: r.toFolder ? { kind: "enum", values: [r.toFolder], optional: false, compare: "path" } : { kind: "forbidden", reason: "no destination folder named: the copy stays in the same folder" },
      newName: r.newName ? { kind: "enum", values: [r.newName], optional: false } : { kind: "forbidden", reason: "no new name given" },
    };
  },
  relevant: (o) => requestedCopy(o) !== null,
  claims: (o) => requestedCopy(o) !== null,
  facets: (o) => { const r = requestedCopy(o); return r ? [{ id: `copy:${pnorm(r.path)}`, tool: "filesystem.copy", description: `copy ${r.path}${r.toFolder ? ` to ${r.toFolder}` : ""}`, data: r }] : []; },
  ground(input, o) {
    const r = requestedCopy(o);
    if (!r) return ungrounded("the request does not ask to copy a file");
    if (pnorm(input.path) !== pnorm(r.path) || pnorm(input.toFolder ?? "") !== pnorm(r.toFolder ?? "") || (input.newName ?? "") !== (r.newName ?? "")) return contradicted("copy exactly the file, folder and name the request gives");
    return grounded("file, destination and name are taken from the request");
  },
  satisfies: (_f, _i, out) => out.ok && out.output?.executed === true && out.output?.verified === true,
  vocabulary: (o) => { const r = requestedCopy(o); return [...CR_VOCAB, ...(r ? [...words(r.path), ...words(r.toFolder ?? ""), ...words(r.newName ?? "")] : [])]; },
};
const renameCheck: ToolRequestCheck<RenameArgs, any> = {
  argumentDomains(o): Record<string, ArgumentDomain> {
    const r = requestedRename(o);
    if (!r) return { path: { kind: "forbidden", reason: "the request does not ask to rename a named file" } };
    return { path: { kind: "enum", values: [r.path], optional: false, compare: "path" }, newName: { kind: "enum", values: [r.newName], optional: false } };
  },
  relevant: (o) => requestedRename(o) !== null,
  claims: (o) => requestedRename(o) !== null,
  facets: (o) => { const r = requestedRename(o); return r ? [{ id: `rename:${pnorm(r.path)}`, tool: "filesystem.rename", description: `rename ${r.path} to ${r.newName}`, data: r }] : []; },
  ground(input, o) {
    const r = requestedRename(o);
    if (!r) return ungrounded("the request does not ask to rename a file");
    return pnorm(input.path) === pnorm(r.path) && input.newName === r.newName ? grounded("file and new name are taken from the request") : contradicted(`rename exactly ${r.path} to ${r.newName}`);
  },
  satisfies: (_f, _i, out) => out.ok && out.output?.executed === true && out.output?.verified === true,
  vocabulary: (o) => { const r = requestedRename(o); return [...CR_VOCAB, ...(r ? [...words(r.path), ...words(r.newName)] : [])]; },
};
const moveCheck: ToolRequestCheck<MoveArgs, any> = {
  argumentDomains(o): Record<string, ArgumentDomain> {
    const r = requestedMove(o);
    if (!r) return { path: { kind: "forbidden", reason: "the request does not ask to move a named file or folder" } };
    return {
      path: { kind: "enum", values: [r.path], optional: false, compare: "path" },
      toFolder: { kind: "enum", values: [r.toFolder], optional: false, compare: "path" },
      newName: r.newName ? { kind: "enum", values: [r.newName], optional: false } : { kind: "forbidden", reason: "no new name given" },
    };
  },
  relevant: (o) => requestedMove(o) !== null,
  claims: (o) => requestedMove(o) !== null,
  facets: (o) => { const r = requestedMove(o); return r ? [{ id: `move:${pnorm(r.path)}`, tool: "filesystem.move", description: `move ${r.path} to ${r.toFolder}`, data: r }] : []; },
  ground(input, o) {
    const r = requestedMove(o);
    if (!r) return ungrounded("the request does not ask to move a file or folder");
    if (pnorm(input.path) !== pnorm(r.path) || pnorm(input.toFolder) !== pnorm(r.toFolder) || (input.newName ?? "") !== (r.newName ?? "")) return contradicted("move exactly the item, to the folder, with the name the request gives");
    return grounded("item, destination and name are taken from the request");
  },
  satisfies: (_f, _i, out) => out.ok && out.output?.executed === true && out.output?.verified === true,
  vocabulary: (o) => { const r = requestedMove(o); return [...CR_VOCAB, "move", "folder", "and", "call", "name", "it", ...(r ? [...words(r.path), ...words(r.toFolder), ...words(r.newName ?? "")] : [])]; },
};
const undoCrCheck: ToolRequestCheck<Record<string, never>, any> = {
  argumentDomains: () => ({}),
  relevant: isUndoCopyRename,
  claims: isUndoCopyRename,
  facets: (o) => (isUndoCopyRename(o) ? [{ id: "undo-copy-rename", tool: "filesystem.undo_copy_rename", description: "undo the last copy or rename", data: null }] : []),
  ground: (_i, o) => (isUndoCopyRename(o) ? grounded("the request asks to undo the last copy or rename") : ungrounded("the request does not ask for this")),
  satisfies: (_f, _i, out) => out.ok && out.output?.executed === true && out.output?.verified === true,
  vocabulary: () => CR_VOCAB,
};

// ── Tools ────────────────────────────────────────────────────────────────────

const fail = (error: string, output?: unknown) => ({ ok: false as const, error, evidence: "", ...(output !== undefined ? { output } : {}) });
const offered = (b: DesktopBridge, t: string) => (b.offers ? b.offers(t) : true);
async function call(bridge: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }): Promise<{ reply: DesktopReply | null; error: string | null }> {
  if (!bridge.available || !offered(bridge, tool)) return { reply: null, error: "File organisation is not enabled (AgentHost:FileOrganize)." };
  try { return { reply: await bridge.call(ctx.taskId, tool, args, ctx.signal, 120_000), error: null }; } catch (e) { return { reply: null, error: e instanceof Error ? e.message : String(e) }; }
}
const inputSchema = {
  type: "object" as const,
  properties: { folder: { type: "string" as const, minLength: 1, maxLength: 400 }, by: { type: "string" as const, enum: ["type", "month", "extension"] } },
  required: ["folder", "by"],
};
const planEvidence = (p: OrganizePlan) => [
  `${p.moves.length} file(s) in ${p.folder} would move into subfolders by ${p.rule}${p.remaining ? ` (${p.batch.length} in the first approval, ${p.remaining} after)` : ""}:`,
  movesText(p.moves.slice(0, 60)) + (p.moves.length > 60 ? `\n… ${p.moves.length - 60} more` : ""),
  p.leftInPlace.length ? `Left in place: ${p.leftInPlace.slice(0, 20).map((l) => `${l.name} (${l.why})`).join("; ")}${p.leftInPlace.length > 20 ? "; …" : ""}.` : "",
].filter(Boolean).join("\n");

export function createOrganizeTools(access: FileAccess, bridge?: DesktopBridge): ToolSpec<any, any>[] {
  const preview: ToolSpec<OrgArgs, any> = {
    name: "filesystem.plan_organize",
    description: "PREVIEW how the files of ONE folder the user names would be organised into subfolders (by type, month or extension). Moves nothing.",
    inputSchema, permissions: ["read:workspace"], risk: "low", requiresApproval: false, timeoutMs: 15_000,
    async execute(input, ctx) {
      const r = await planOrganize(access, input.folder!, input.by!, ctx.signal);
      if (!r.ok) return fail(r.error);
      return { ok: true, output: { folder: r.plan.folder, rule: r.plan.rule, moves: r.plan.moves, leftInPlace: r.plan.leftInPlace }, evidence: `Preview only (nothing was moved). ${planEvidence(r.plan)}` };
    },
    requestCheck: organizeCheck("preview"),
  };
  if (!bridge) return [preview];
  const organize: ToolSpec<OrgArgs, any> = {
    name: "filesystem.organize",
    description: "Ask the user (in the HUD) to approve organising the files of ONE folder they named into subfolders (by type, month or extension). " +
      "D-ASK computes the exact moves; the daemon shows them, moves the files (never overwriting) and keeps an undo record.",
    inputSchema, permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 150_000,
    async execute(input, ctx) {
      const r = await planOrganize(access, input.folder!, input.by!, ctx.signal);
      if (!r.ok) return fail(r.error);
      if (r.plan.batch.length === 0) return fail(`Nothing in ${r.plan.folder} would move by ${r.plan.rule}.`);
      const { reply, error } = await call(bridge, "files.organize", { folder: r.plan.canonical, moves: r.plan.batch }, ctx);
      if (!reply) return fail(error!);
      if (reply.status !== "ok") return fail(reply.error?.message ?? "The request was not approved. Nothing was moved.");
      const res = reply.result ?? {};
      const output = { ...res, rule: r.plan.rule, remaining: r.plan.remaining + (res.total ?? 0) - (res.moved ?? 0) };
      if (!(res.executed === true && res.verified === true)) return fail(`Moved ${res.moved ?? 0} of ${res.total ?? r.plan.batch.length}${res.stopped ? ` (stopped: ${res.stopped})` : ""}; not confirmed as complete.`, output);
      return { ok: true, output, evidence: `Moved and verified ${res.moved} file(s) in ${r.plan.folder} into subfolders by ${r.plan.rule}:\n${movesText(r.plan.batch)}` +
        (output.remaining ? `\n${output.remaining} more file(s) would still move; ask again to continue (each batch is approved separately).` : "") +
        `\nUndo is available: "undo the last file organisation".` };
    },
    check: (_i, o) => (o.output?.executed === true && o.output?.verified === true ? { ok: true } : { ok: false, reason: "the moves were not performed and verified" }),
    requestCheck: organizeCheck("do"),
  };
  const undo: ToolSpec<Record<string, never>, any> = {
    name: "filesystem.undo_organize",
    description: "Ask the user (in the HUD) to approve moving back the files of the most recent organisation (only files still exactly as D-ASK left them).",
    inputSchema: { type: "object", properties: {} }, permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 150_000,
    async execute(_input, ctx) {
      const { reply, error } = await call(bridge, "files.undo_organize", {}, ctx);
      if (!reply) return fail(error!);
      if (reply.status !== "ok") return fail(reply.error?.message ?? "The request was not approved. Nothing was moved.");
      const res = reply.result ?? {};
      if (!(res.executed === true && res.verified === true)) return fail(`Moved back ${res.moved ?? 0} of ${res.total ?? 0}${res.stopped ? ` (stopped: ${res.stopped})` : ""}.`, res);
      return { ok: true, output: res, evidence: `Moved back and verified ${res.moved} file(s) in ${res.folder}: ${(res.moves ?? []).map((m: any) => m.name).join(", ")}.` };
    },
    check: (_i, o) => (o.output?.executed === true && o.output?.verified === true ? { ok: true } : { ok: false, reason: "not moved back and verified" }),
    requestCheck: undoCheck,
  };
  const daemonStep = (tool: string, daemonTool: string, description: string, check: ToolRequestCheck<any, any>, schema: ToolSpec["inputSchema"],
    done: (res: any) => string): ToolSpec<any, any> => ({
    name: tool, description, inputSchema: schema, permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 150_000,
    async execute(input, ctx) {
      const { reply, error } = await call(bridge, daemonTool, input, ctx);
      if (!reply) return fail(error!);
      if (reply.status !== "ok") return fail(reply.error?.message ?? "The request was not approved. Nothing was changed.");
      const res = reply.result ?? {};
      if (!(res.executed === true && res.verified === true)) return fail(`Not confirmed${res.stopped ? ` (${res.stopped})` : ""}.`, res);
      return { ok: true, output: res, evidence: done(res) };
    },
    check: (_i, o) => (o.output?.executed === true && o.output?.verified === true ? { ok: true } : { ok: false, reason: "not performed and verified" }),
    requestCheck: check,
  });
  const copy = daemonStep("filesystem.copy", "files.copy",
    "Ask the user (in the HUD) to approve copying ONE file they named (full path) into a folder they named (or the same folder), optionally with a new name. Never overwrites; a taken name gets ' (copy)'.",
    copyCheck, { type: "object", properties: { path: { type: "string", minLength: 4, maxLength: 400 }, toFolder: { type: "string", minLength: 3, maxLength: 400 }, newName: { type: "string", minLength: 1, maxLength: 120 } }, required: ["path"] },
    (r) => `Copied ${r.source} to ${r.destination}${r.renamedBecauseTaken ? " (the name was taken, so the copy got a free name)" : ""}; verified byte for byte (SHA-256 ${String(r.sha256).slice(0, 12)}…). Done; it can be undone later on request.`);
  const rename = daemonStep("filesystem.rename", "files.rename",
    "Ask the user (in the HUD) to approve renaming ONE file they named (full path) to the new name they gave, in the same folder. Never overwrites.",
    renameCheck, { type: "object", properties: { path: { type: "string", minLength: 4, maxLength: 400 }, newName: { type: "string", minLength: 1, maxLength: 120 } }, required: ["path", "newName"] },
    (r) => `Renamed ${r.from} to ${r.to} in ${r.folder}; verified. Done; it can be undone later on request.`);
  const undoCr = daemonStep("filesystem.undo_copy_rename", "files.undo_copy_rename",
    "Ask the user (in the HUD) to approve undoing the most recent copy (removing that unchanged copy) or rename (renaming it back).",
    undoCrCheck, { type: "object", properties: {} }, (r) => `Undid the last ${r.kind}: ${r.path}; verified.`);
  const move = daemonStep("filesystem.move", "files.move",
    "Ask the user (in the HUD) to approve moving ONE file or ONE folder they named (full path) into another folder they named, optionally with a new name. Never overwrites: a taken name is reported, not replaced.",
    moveCheck, { type: "object", properties: { path: { type: "string", minLength: 4, maxLength: 400 }, toFolder: { type: "string", minLength: 3, maxLength: 400 }, newName: { type: "string", minLength: 1, maxLength: 120 } }, required: ["path", "toFolder"] },
    (r) => `Moved ${r.kind === "folder" ? `the folder (${r.files} file(s))` : "the file"} ${r.source} to ${r.destination}; verified (${r.kind === "folder" ? "every file's SHA-256" : "SHA-256"}, and the source is gone). Done; it can be undone on request ("undo the last move").`);
  return [preview, organize, undo, copy, rename, undoCr, move];
}
