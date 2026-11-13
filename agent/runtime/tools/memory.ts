// ─────────────────────────────────────────────────────────────────────────────
// Memory tools over the local MemoryStore. The model never decides WHAT is stored or deleted: the content to remember is
// pinned to the user's own words ("remember that …"), recall only reads, and forgetting deletes only entries matching
// the subject the user named (at most MAX_FORGET per request; "forget everything" is a user control, not a chat action).
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords } from "../grounding";
import { MemoryRefusedError, secretIn, type MemoryKind, type MemoryStore } from "../memory/memoryStore";
import type { GroundingVerdict, RequestFacet, ToolRequestCheck, ToolSpec } from "../types";

export const MAX_FORGET = 5;
const POLITE = /^\s*(?:please\s+|hey\s+d-?ask,?\s+|d-?ask,?\s+)?/i;
const REMEMBER = new RegExp(`${POLITE.source}(?:remember|note|keep\\s+in\\s+mind|don't\\s+forget)\\s*(?:that\\s+|:\\s*)?(.{2,1000}?)\\s*[.!]?\\s*$`, "i");
const FORGET = new RegExp(`${POLITE.source}forget\\s+(?:that\\s+|about\\s+|what\\s+you\\s+know\\s+about\\s+|everything\\s+about\\s+|my\\s+)?(.{2,200}?)\\s*[.!]?\\s*$`, "i");
const RECALL = /\b(what\s+do\s+you\s+(?:remember|know)\s+about|do\s+you\s+remember|what(?:'s|\s+is|\s+are)\s+my|who\s+is\s+my|recall|remind\s+me\s+(?:what|who|of)|what\s+did\s+i\s+tell\s+you)\b/i;
const ALL = /^\s*(everything|all|it\s+all|all\s+of\s+it|all\s+memories|your\s+memory)\s*$/i;
// Memory management (HUD panel and chat): list what is saved, and forget ONE entry by the short id the list shows.
const LIST_MEM = /^\s*(?:please\s+)?(?:(?:list|show)(?:\s+me)?(?:\s+(?:all|my|the|saved))*\s+(?:memories|saved\s+notes|remembered\s+(?:things|notes))|what\s+do\s+you\s+(?:remember|know)(?:\s+about\s+me)?)\s*[.!?]?\s*$/i;
const FORGET_ID = /^\s*(?:please\s+)?forget\s+(?:the\s+)?memory\s+([0-9a-f]{8})\s*[.!]?\s*$/i;
export const isListMemories = (o: string) => LIST_MEM.test(o);
export const forgetMemoryId = (o: string): string | null => FORGET_ID.exec(o)?.[1]?.toLowerCase() ?? null;

export function rememberedContent(objective: string): string | null {
  if (FORGET.test(objective)) return null;
  const m = REMEMBER.exec(objective);
  if (!m) return null;
  let c = m[1]!.trim();
  // First person is kept as the user said it ("my sister is Asha" stays about the user).
  if (c.length < 2) return null;
  c = c.replace(/^(?:that\s+)/i, "");
  return c;
}
export function forgetSubject(objective: string): string | null {
  if (FORGET_ID.test(objective)) return null;
  const m = FORGET.exec(objective);
  return m ? m[1]!.trim() : null;
}
export const isRecallRequest = (o: string) => RECALL.test(o) && !rememberedContent(o) && !forgetSubject(o) && !LIST_MEM.test(o);

export function kindOf(content: string): MemoryKind {
  if (/\b(i\s+(?:prefer|like|love|hate|dislike|enjoy|don't\s+like)|my\s+favou?rite|i\s+(?:always|usually|never)\b|call\s+me)\b/i.test(content)) return "preference";
  if (/\bmy\s+(?:wife|husband|partner|sister|brother|mother|mom|mum|father|dad|son|daughter|friend|boss|manager|colleague|team\s*mate)\b/i.test(content)) return "person";
  if (/\b(project|deadline|repo(?:sitory)?|sprint|release|milestone)\b/i.test(content)) return "project";
  return "fact";
}

// Search tags for a remembered RESULT (agent/host/compose.ts writes "<subject>: <answer> (source: <label>)"): the subject's words, so the
// entry is found by what it is about. Derived by code from the stored text itself (the model supplies nothing); other contents get none.
const COMPOSED = /^([^:]{2,120}):\s.+\(source: [^()]{1,80}\)$/s;
const TAG_STOP = new Set("a an the and or of to in on at for is are was were be my our your it this that what who when where which how do does did about with from by".split(" "));
export function tagsFor(content: string): string[] {
  const m = COMPOSED.exec(content.trim());
  if (!m) return [];
  const words = m[1]!.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((w) => w.length >= 2 && !TAG_STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

const grounded = (r: string): GroundingVerdict => ({ status: "grounded", reason: r });
const ungrounded = (r: string): GroundingVerdict => ({ status: "ungrounded", reason: r });
const contradicted = (r: string): GroundingVerdict => ({ status: "contradicted", reason: r });
const VOCAB = ["remember", "note", "keep", "in", "mind", "don't", "forget", "that", "about", "what", "do", "you", "know", "is", "my", "are", "who", "recall", "remind", "me", "of", "did", "i", "tell", "please", "everything"];

export function createMemoryTools(store: MemoryStore): ToolSpec<any, any>[] {
  const remember: ToolSpec<{ content: string }, any> = {
    name: "memory.remember",
    description: "Store ONE thing the user explicitly asked you to remember, in their own words (content exactly as the request says after 'remember that'). Stored locally on this computer only.",
    inputSchema: { type: "object", properties: { content: { type: "string", minLength: 2, maxLength: 1000 } }, required: ["content"] },
    permissions: ["memory:write"], risk: "low", requiresApproval: false, timeoutMs: 5000,
    async execute(input) {
      try {
        const { entry, created } = store.remember({ kind: kindOf(input.content), content: input.content, tags: tagsFor(input.content), source: "user" });
        return { ok: true, output: { stored: true, created, id: entry.id, kind: entry.kind }, evidence: `${created ? "Remembered" : "Already remembered; refreshed"}: "${entry.content}" (${entry.kind}). Stored only on this computer.` };
      } catch (e) {
        return { ok: false, error: e instanceof MemoryRefusedError ? `Not stored: ${e.message}.` : `Memory is unavailable: ${e instanceof Error ? e.message : e}`, evidence: "" };
      }
    },
    check: (_i, o) => (o.output?.stored === true ? { ok: true } : { ok: false, reason: "nothing was stored" }),
    requestCheck: {
      argumentDomains: (o) => { const c = rememberedContent(o); return { content: c ? { kind: "enum", values: [c], optional: false } : { kind: "forbidden", reason: "the request asks to remember nothing" } }; },
      relevant: (o) => rememberedContent(o) !== null,
      clarify: (o) => { const c = rememberedContent(o); const s = c && secretIn(c); return s ? `I won't remember that: it looks like ${s}, and D-ASK never stores those.` : null; },
      facets: (o) => { const c = rememberedContent(o); return c ? [{ id: "memory:remember", tool: "memory.remember", description: `remember "${c}"`, data: { content: c } } satisfies RequestFacet] : []; },
      ground: (input, o) => { const c = rememberedContent(o); return !c ? ungrounded("the request asks to remember nothing") : input.content === c ? grounded("the user's own words") : contradicted(`store exactly: ${c}`); },
      satisfies: (f, input, out) => out.ok && out.output?.stored === true && input.content === (f.data as { content: string }).content,
      vocabulary: (o) => [...VOCAB, ...contentWords(rememberedContent(o) ?? "")],
    },
  };

  const recall: ToolSpec<{ query: string }, any> = {
    name: "memory.recall",
    description: "Look up what the user previously asked you to remember (local memory). query: the user's question as asked.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 500 } }, required: ["query"] },
    permissions: ["memory:read"], risk: "low", requiresApproval: false, timeoutMs: 5000,
    async execute(input) {
      const hits = store.recall(input.query, { limit: 5 });
      return {
        ok: true, output: { hits: hits.map((h) => ({ id: h.id, kind: h.kind, content: h.content, score: h.score, updatedAt: h.updatedAt })), searched: true },
        evidence: hits.length ? ["From your saved memories:", ...hits.map((h) => `• ${h.content} (${h.kind}, saved ${h.updatedAt.slice(0, 10)})`)].join("\n") : "I have nothing saved about that.",
      };
    },
    requestCheck: {
      argumentDomains: (o) => ({ query: isRecallRequest(o) ? { kind: "enum", values: [o.trim()], optional: false } : { kind: "forbidden", reason: "the request does not ask what I remember" } }),
      relevant: isRecallRequest,
      facets: (o) => (isRecallRequest(o) ? [{ id: "memory:recall", tool: "memory.recall", description: "look up saved memories", data: {} }] : []),
      ground: (input, o) => (!isRecallRequest(o) ? ungrounded("not a recall request") : input.query === o.trim() ? grounded("the user's question") : contradicted("use the user's question as asked")),
      satisfies: (_f, _i, out) => out.ok && out.output?.searched === true,
      vocabulary: (o) => [...VOCAB, ...contentWords(o)],
    },
  };

  const forget: ToolSpec<{ subject: string }, any> = {
    name: "memory.forget",
    description: "Delete the saved memories about ONE subject the user named (exactly as the request says after 'forget').",
    inputSchema: { type: "object", properties: { subject: { type: "string", minLength: 2, maxLength: 200 } }, required: ["subject"] },
    permissions: ["memory:write"], risk: "medium", requiresApproval: false, timeoutMs: 5000,
    async execute(input) {
      const matches = store.matchingAll(input.subject);
      if (matches.length === 0) return { ok: true, output: { deleted: 0, matched: 0 }, evidence: `I had nothing saved about "${input.subject}".` };
      if (matches.length > MAX_FORGET) return { ok: false, output: { deleted: 0, matched: matches.length }, error: `${matches.length} saved memories mention "${input.subject}"; please be more specific (I delete at most ${MAX_FORGET} at a time from chat).`, evidence: "" };
      const gone = matches.filter((m) => store.forget(m.id));
      const still = gone.filter((m) => store.get(m.id) !== null);
      return { ok: still.length === 0, output: { deleted: gone.length - still.length, matched: matches.length },
        evidence: `Deleted ${gone.length} saved ${gone.length === 1 ? "memory" : "memories"}:\n${gone.map((m) => `• ${m.content}`).join("\n")}` };
    },
    check: (_i, o) => (o.output && o.output.deleted === o.output.matched ? { ok: true } : { ok: false, reason: "not everything matched was deleted" }),
    requestCheck: {
      argumentDomains: (o) => { const s = forgetSubject(o); return { subject: s && !ALL.test(s) ? { kind: "enum", values: [s], optional: false } : { kind: "forbidden", reason: "the request names no single subject to forget" } }; },
      relevant: (o) => forgetSubject(o) !== null,
      clarify: (o) => { const s = forgetSubject(o); return s && ALL.test(s) ? "To erase everything I remember, use the memory controls (D-ASK settings, or: npx tsx agent/runtime/memory/memoryCli.ts clear --yes). From chat I only forget one subject at a time." : null; },
      facets: (o) => { const s = forgetSubject(o); return s && !ALL.test(s) ? [{ id: "memory:forget", tool: "memory.forget", description: `forget saved memories about "${s}"`, data: { subject: s } }] : []; },
      ground: (input, o) => { const s = forgetSubject(o); return !s ? ungrounded("not a forget request") : input.subject === s ? grounded("the subject the user named") : contradicted(`forget exactly: ${s}`); },
      satisfies: (f, input, out) => out.ok && input.subject === (f.data as { subject: string }).subject && out.output?.deleted === out.output?.matched,
      vocabulary: (o) => [...VOCAB, ...contentWords(forgetSubject(o) ?? "")],
    },
  };
  const list: ToolSpec<Record<string, never>, any> = {
    name: "memory.list",
    description: "List the memories saved on this computer (short id, text, kind), newest first. Read-only.",
    inputSchema: { type: "object", properties: {} },
    permissions: ["memory:read"], risk: "low", requiresApproval: false, timeoutMs: 5000,
    async execute() {
      const all = store.list({ limit: 30 });
      const total = store.count();
      const lines = all.map((e) => `• [${e.id.slice(0, 8)}] ${e.content.slice(0, 200)} (${e.kind}${e.source === "user" ? "" : `, ${e.source}`})`);
      return { ok: true, output: { count: total, shown: all.length }, evidence: total === 0 ? "I have no saved memories." : `${lines.join("\n")}${total > all.length ? `\n(${total - all.length} older memories not shown)` : ""}` };
    },
    check: (_i, o) => (typeof o.output?.count === "number" ? { ok: true } : { ok: false, reason: "no count" }),
    requestCheck: {
      argumentDomains: () => ({}), relevant: isListMemories, claims: isListMemories,
      facets: (o) => (isListMemories(o) ? [{ id: "memory:list", tool: "memory.list", description: "list the saved memories", data: {} } satisfies RequestFacet] : []),
      ground: (_i, o) => (isListMemories(o) ? grounded("asked to list memories") : ungrounded("not a list request")),
      satisfies: (_f, _i, out) => out.ok && typeof out.output?.count === "number",
      vocabulary: () => [...VOCAB, "list", "show", "all", "saved", "memories", "notes", "remembered", "things"],
    },
  };
  const forgetById: ToolSpec<{ id: string }, any> = {
    name: "memory.forget_id",
    description: "Delete ONE saved memory by the short id the memory list shows (exactly as the request says after 'forget memory').",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 8, maxLength: 8 } }, required: ["id"] },
    permissions: ["memory:write"], risk: "medium", requiresApproval: false, timeoutMs: 5000,
    async execute(input) {
      const hits = store.list({ limit: 1000 }).filter((e) => e.id.toLowerCase().startsWith(input.id.toLowerCase()));
      if (hits.length === 0) return { ok: true, output: { deleted: false, matched: 0 }, evidence: `No saved memory has the id ${input.id}.` };
      if (hits.length > 1) return { ok: false, output: { deleted: false, matched: hits.length }, error: `${hits.length} memories share the id ${input.id}; nothing was deleted.`, evidence: "" };
      const e = hits[0]!;
      const gone = store.forget(e.id) && store.get(e.id) === null;
      return { ok: gone, output: { deleted: gone, matched: 1 }, ...(gone ? { evidence: `Deleted the memory: ${e.content.slice(0, 200)}` } : { error: "The memory could not be deleted.", evidence: "" }) };
    },
    check: (_i, o) => (o.output?.deleted === true || o.output?.matched === 0 ? { ok: true } : { ok: false, reason: "not deleted" }),
    requestCheck: {
      argumentDomains: (o) => { const id = forgetMemoryId(o); return { id: id ? { kind: "enum", values: [id], optional: false } : { kind: "forbidden", reason: "the request names no memory id" } }; },
      relevant: (o) => forgetMemoryId(o) !== null, claims: (o) => forgetMemoryId(o) !== null,
      facets: (o) => { const id = forgetMemoryId(o); return id ? [{ id: `memory:forget_id:${id}`, tool: "memory.forget_id", description: `forget the memory ${id}`, data: { id } } satisfies RequestFacet] : []; },
      ground: (i, o) => { const id = forgetMemoryId(o); return !id ? ungrounded("not a forget-by-id request") : i.id.toLowerCase() === id ? grounded("the id the user named") : contradicted(`forget exactly: ${id}`); },
      satisfies: (f, i, out) => out.ok && i.id.toLowerCase() === (f.data as { id: string }).id && out.output?.deleted === true,
      vocabulary: (o) => [...VOCAB, "memory", "the", ...contentWords(forgetMemoryId(o) ?? "")],
    },
  };
  return [remember, recall, forget, list, forgetById];
}
