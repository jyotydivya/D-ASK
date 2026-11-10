// ─────────────────────────────────────────────────────────────────────────────
// Notes (agent side): "Create a note titled Meeting. The note should contain the exact words "…"."
//
// The model chooses NOTHING about what is written or where:
//   - the title and the exact text are read from the request itself (the text must be quoted); the model may only
//     repeat the title, pinned to the request (argument domain);
//   - the daemon is the authority (NoteCreateRequestService): it derives the only possible path
//     <notes folder>\<title>.txt, shows the exact title and text for approval, writes a NEW file (never overwriting)
//     and reads it back;
//   - this tool then verifies independently: it re-reads the file and compares it byte for byte with the requested text.
// A note that was not written AND verified is never reported as created.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolRequestCheck, ToolSpec } from "../types";
import type { DesktopBridge, DesktopReply } from "./desktop";

export const NOTE_EXTENSION = ".txt";
export const MAX_NOTE_TEXT = 2000;

const CREATE = /\b(?:create|make|write|add|take|save|start)\s+(?:me\s+)?(?:a\s+|an\s+|one\s+)?(?:new\s+)?(?:text\s+)?note\b/i;
// Typing into an app is desktop input, not a note file.
const NOT_A_FILE = /\b(notepad|window|field|text\s*box|textbox|app|application|editor|onenote|sticky)\b/i;
const TITLE = new RegExp(String.raw`\bnote\s+(?:titled|entitled|called|named|with\s+(?:the\s+)?(?:title|name))\s+` +
  String.raw`(?:["“']([^"”']{1,60})["”']|([\p{L}\p{N}][\p{L}\p{N} _'&()+,-]{0,59}?))` +
  String.raw`(?=\s*(?:[.:;!?]|,|["“]|\s(?:that|which|with|saying|containing|and|to|reading)\b|$))`, "iu");
const CONTENT_CUE = /\b(contain(?:s|ing)?|say(?:s|ing)?|read(?:s|ing)?|text|words?|content|body|with)\b|:/i;
const QUOTED = /["“]([^"”]*)["”]/g;
const SAFE_TITLE = /^[\p{L}\p{N}][\p{L}\p{N} _.,'()&+-]{0,59}$/u;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const isSafeNoteTitle = (t: string) => SAFE_TITLE.test(t) && !RESERVED.test(t) && !/[. ]$/.test(t) && !t.includes("..");

/** Text the daemon accepts and the HUD can show exactly (mirrors NoteCreateRequestService.CheckText). */
export function noteTextProblem(text: string): string | null {
  if (text.length === 0 || text.length > MAX_NOTE_TEXT) return `the note text must be 1 to ${MAX_NOTE_TEXT} characters`;
  if (!text.trim()) return "the note text is empty";
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(text)) return "the note text contains characters that cannot be shown exactly";
  return null;
}

/** Whether the request asks to create a note file at all (title and text may still be missing). */
export const isNoteRequest = (o: string) => CREATE.test(o) && !NOT_A_FILE.test(o);

export interface RequestedNote { title: string; text: string }

/**
 * Dictated quotation marks in a request that has no quote characters (typed as spoken, or a recognizer that kept the
 * words): "open quote … close quote", "quote … unquote", "quote … end quote" become "…". Same rules as the HUD's
 * stt::normalize_quotes (commas and spaces around the quoted words are dropped; punctuation after the closing marker stays
 * outside). A marker without its partner changes nothing.
 */
export function spokenQuotes(o: string): string {
  if (/["“”]/.test(o)) return o;
  const bare = (w: string | undefined) => (w ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  const toks = o.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = bare(toks[i]);
    const open = w === "quote" ? 1 : w === "open" && bare(toks[i + 1]) === "quote" ? 2 : 0;
    if (open) {
      let close: [number, number] | null = null;
      for (let j = i + open; j < toks.length; j++) {
        const a = bare(toks[j]), b = bare(toks[j + 1]);
        if (a === "unquote") { close = [j, 1]; break; }
        if ((a === "close" || a === "end") && b === "quote") { close = [j, 2]; break; }
      }
      if (close && close[0] > i + open) {
        const inner = toks.slice(i + open, close[0]).join(" ").replace(/^[\s,]+|[\s,]+$/g, "");
        const last = toks[close[0] + close[1] - 1]!;
        const tail = /[^\p{L}\p{N}]*$/u.exec(last)![0];
        out.push(`"${inner}"${tail}`);
        i = close[0] + close[1] - 1;
        continue;
      }
    }
    out.push(toks[i]!);
  }
  return out.join(" ");
}

/** The note a request asks for: a title after "titled/called/named", and exactly ONE quoted text after it. Else null. */
export function requestedNote(request: string): RequestedNote | null {
  const o = spokenQuotes(request);
  if (!isNoteRequest(o)) return null;
  const t = TITLE.exec(o);
  if (!t) return null;
  const title = (t[1] ?? t[2] ?? "").trim();
  if (!isSafeNoteTitle(title)) return null;
  const rest = o.slice(t.index + t[0].length);
  const quotes = [...rest.matchAll(QUOTED)];
  if (quotes.length !== 1) return null;                       // none, or ambiguous: ask instead
  const before = rest.slice(0, quotes[0]!.index);
  if (!CONTENT_CUE.test(before)) return null;                  // the quote must be introduced as the note's content
  const text = quotes[0]![1]!.trim();
  if (noteTextProblem(text)) return null;
  return { title, text };
}

function clarifyNote(o: string, offered: boolean): string | null {
  if (!isNoteRequest(o)) return null;
  if (!offered) return "Creating notes is not enabled in D-ASK (AgentHost:Notes).";
  if (requestedNote(o)) return null;
  if (!TITLE.test(spokenQuotes(o))) return "What should the note be titled? For example: create a note titled Meeting containing \"…\".";
  return "What exactly should the note say? Please give exactly one text in quotes (say \"open quote … close quote\").";
}

// ── Checks ─────────────────────────────────────────────────────────────────────

const grounded = (r: string): GroundingVerdict => ({ status: "grounded", reason: r });
const ungrounded = (r: string): GroundingVerdict => ({ status: "ungrounded", reason: r });
const contradicted = (r: string): GroundingVerdict => ({ status: "contradicted", reason: r });

/** Independent artifact check: the file is <notes folder>\<title>.txt and holds exactly the text, byte for byte. */
export function verifyNoteFile(file: unknown, title: string, text: string, notesDir: string | undefined): { ok: boolean; reason?: string } {
  if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, reason: "no note file in the result" };
  if (path.basename(file).toLowerCase() !== (title + NOTE_EXTENSION).toLowerCase()) return { ok: false, reason: "the file name is not the note's title" };
  if (notesDir && path.resolve(path.dirname(file)).toLowerCase() !== path.resolve(notesDir).toLowerCase()) return { ok: false, reason: "the note is not in the notes folder" };
  try {
    if (!statSync(file).isFile()) return { ok: false, reason: "the note is not a file" };
    const bytes = readFileSync(file);
    return bytes.equals(Buffer.from(text, "utf8")) ? { ok: true } : { ok: false, reason: "the note's content is not exactly the requested text" };
  } catch {
    return { ok: false, reason: "the note file does not exist or cannot be read" };
  }
}

// ── Tool ───────────────────────────────────────────────────────────────────────

const fail = (error: string, output?: unknown) => ({ ok: false as const, error, evidence: "", ...(output !== undefined ? { output } : {}) });
const offered = (b: DesktopBridge) => b.available && (b.offers ? b.offers("notes.create") : true);

export function createNoteTools(bridge: DesktopBridge, notesDir: string | undefined = process.env.DASK_NOTES_DIR): ToolSpec<any, any>[] {
  const check: ToolRequestCheck<{ title?: string }, any> = {
    argumentDomains(o): Record<string, ArgumentDomain> {
      const n = requestedNote(o);
      return { title: n ? { kind: "enum", values: [n.title], optional: false, compare: "exact" } : { kind: "forbidden", reason: "the request names no note to create" } };
    },
    relevant: (o) => isNoteRequest(o),
    // The quoted text is content to store, not an instruction: this tool owns the whole request.
    claims: (o) => isNoteRequest(o),
    clarify: (o) => clarifyNote(o, offered(bridge)),
    facets(o): RequestFacet[] {
      const n = requestedNote(o);
      return n && offered(bridge) ? [{ id: `note:${n.title.toLowerCase()}`, tool: "notes.create", description: `create the note "${n.title}"`, data: n }] : [];
    },
    ground(input, o) {
      const n = requestedNote(o);
      if (!n) return ungrounded("the request does not ask to create a note with a title and quoted text");
      return input.title === n.title ? grounded("the title and text are taken from the request") : contradicted(`the request names the note "${n.title}"`);
    },
    satisfies(facet, input, outcome) {
      const n = facet.data as RequestedNote;
      const out = outcome.output;
      return outcome.ok && input.title === n.title && out?.executed === true && out?.verified === true && out?.artifactVerified === true &&
        out?.title === n.title && out?.text === n.text;
    },
    // Every word is the note's title, its text, or the request to create it (same tokenizer as grounding.unexplainedWords).
    vocabulary: (o) => (requestedNote(o) ? contentWords(o) : []),
  };

  const create: ToolSpec<{ title: string }, any> = {
    name: "notes.create",
    description: "Ask the user (in the HUD) to approve creating ONE new text note with the title and the exact quoted text from the request " +
      "(\"Create a note titled X containing \\\"…\\\"\"). Give only the title; the text is taken from the request. D-ASK's notes folder only; never overwrites.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 60 } }, required: ["title"] },
    permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 120_000,
    async execute(input, ctx) {
      const n = ctx.objective !== undefined ? requestedNote(ctx.objective) : null;
      if (!n || input.title !== n.title) return fail("The request does not name a note to create (a title, then the exact text in quotes).");
      if (!offered(bridge)) return fail("Creating notes is not enabled (AgentHost:Notes).");
      let reply: DesktopReply;
      try { reply = await bridge.call(ctx.taskId, "notes.create", { title: n.title, text: n.text }, ctx.signal, 110_000); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
      if (reply.status !== "ok") return fail(reply.error?.message ?? "The note was not approved. Nothing was written.");
      const res = (reply.result ?? {}) as Record<string, unknown>;
      if (!(res.executed === true && res.verified === true)) return fail("The daemon did not confirm the note as written and verified.", { ...res, artifactVerified: false });
      // Independent verification of the artifact itself, not of what the daemon said.
      const v = verifyNoteFile(res.file, n.title, n.text, notesDir);
      const output = { ...res, title: n.title, text: n.text, artifactVerified: v.ok };
      if (!v.ok) return fail(`The note could not be verified: ${v.reason}.`, output);
      return { ok: true, output, evidence: `Created the note "${n.title}" (${res.file}) and read it back: it contains exactly:\n${n.text}` };
    },
    check(input, outcome) {
      const o = outcome.output;
      if (!o || o.artifactVerified !== true) return { ok: false, reason: "the note was not written and verified" };
      return verifyNoteFile(o.file, input.title, o.text, notesDir);
    },
    requestCheck: check,
  };
  return [create];
}
