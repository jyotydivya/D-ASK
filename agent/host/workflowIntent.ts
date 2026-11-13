// Natural-language workflow management: the LOCAL model reads the request and describes it as structured JSON; the host then VALIDATES
// that description deterministically against the user's own words and the user's real saved workflows, and only a validated result
// is turned into a daemon call. The model has no authority: it cannot name a workflow that does not exist, add words to a saved step,
// supply a time the user did not say, or turn one operation into another. Anything unclear becomes a question and NO daemon action.
//
//   request ──gate──▶ model (untrusted JSON) ──validate──▶ { call | clarify | none }
//                                   │               │ the model contributes: which operation, which workflow, the steps of a new workflow
//                                   │               │ the host derives: repeat / weekday / date / clock time from the user's own words (a closed,
//                                   │               │ formal domain), resolves the name against the saved workflows, grounds steps, cross-checks the
//                                   │               │ operation against the request's own words, detects mixed/contradictory asks
//   daemon tools (unchanged): validation, schedule approval card, store, authorization.
//
// This is deliberately NOT a sentence grammar: the gate and the evidence checks are broad word-stem sanity checks, not templates.

import type { LanguageModel } from "../runtime/types";
import type { ManageOp } from "./workflowManage";

export interface KnownWorkflow { name: string; steps: number; schedule: string | null }
export type Intent =
  | { kind: "none" }
  | { kind: "clarify"; question: string }
  | { kind: "call"; op: ManageOp; args: Record<string, unknown>; note?: string };

// ── gate: does this request deserve a model look at all? (relevance only; the model decides what it means) ──
const GATE = /\b(workflows?|automations?|automat\w*|routines?|macros?|schedul\w*|unschedul\w*|triggers?|recurring|repeat\w*|daily|weekly|nightly|each\s+(?:day|week|morning|evening|night)|every\s+\w+|anymore|any\s+longer|no\s+longer|timer)\b/i;
const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []).map((w) => w.replace(/[._-]+$/, ""));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-name mention: not glued to other name characters, so "backup" is not inside "backup-weekly". */
const mentions = (text: string, name: string) => new RegExp(String.raw`(?<![\p{L}\p{N}_.-])${escapeRe(name)}(?![\p{L}\p{N}_-])`, "iu").test(text);

/** The request with every workflow name blanked out: a name such as "backup-weekly" or "nightly" must not count as scheduling words in the evidence checks. */
function masked(objective: string, names: readonly string[]): string {
  let t = objective;
  for (const n of [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(String.raw`(?<![\p{L}\p{N}_.-])${escapeRe(n)}(?![\p{L}\p{N}_-])`, "giu"), " ");
  return t;
}

/** Verbs of managing something that exists. A saved workflow's name alone ("time", "backup") must not claim an ordinary question ("What time is it?"). */
const MANAGE_VERB = /\b(delet\w*|remov\w*|eras\w*|discard\w*|trash\w*|wipe\w*|scrap\w*|forget|drop\w*|dispos\w*|throw\w*|get\s+rid|stop\w*|cancel\w*|disabl\w*|pause\w*|halt\w*|kill\w*|unschedul\w*|schedul\w*|run\w*|start\w*|launch\w*|execut\w*|fire\w*|kick\w*|go\s+off|rename\w*|list\w*|show\w*)\b/i;
export function passesGate(objective: string, known: readonly KnownWorkflow[]): boolean {
  return GATE.test(objective) || (MANAGE_VERB.test(objective) && known.some((k) => mentions(objective, k.name)));
}

/**
 * A NEW workflow's name must be introduced by the user: "called X", "named X", "call it X", "with the name X", or a name in double quotes. A word that merely
 * appears elsewhere ("a routine that tells me the time") is never a name. The model may only pick among what the user actually introduced.
 */
export function explicitlyNamed(objective: string, name: string): boolean {
  const n = escapeRe(name);
  const bounded = String.raw`(?<![\p{L}\p{N}_.-])${n}(?![\p{L}\p{N}_-])`;
  const intro = String.raw`(?:called|named|titled|labell?ed|dubbed|name\s+(?:it|this|that)|call\s+(?:it|this|that)|with\s+the\s+name|by\s+the\s+name(?:\s+of)?)\s*[:,]?\s*(?:it\s+)?["\u201c'\u2018]?`;
  return new RegExp(intro + bounded, "iu").test(objective) || new RegExp(String.raw`["\u201c]${n}["\u201d]`, "iu").test(objective);
}

// ── the model's side ────────────────────────────────────────────────────────────────────────────────────
export const OPERATIONS = ["save", "list", "delete", "schedule", "unschedule", "run", "other", "unclear"] as const;
export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: [...OPERATIONS] },
    workflow_name: { type: "string", maxLength: 40 },
    steps: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 8 },
    ask: { type: "string", maxLength: 200 },
  },
  required: ["operation", "workflow_name", "steps", "ask"],
} as const;

export function intentPrompt(known: readonly KnownWorkflow[]): string {
  const list = known.length ? known.map((k) => `"${k.name}"${k.schedule ? ` (runs ${k.schedule})` : " (not scheduled)"}`).join(", ") : "none yet";
  return [
    "You read ONE request to a desktop assistant and say whether it is about the user's SAVED WORKFLOWS (a workflow, also called an automation or routine, is a named list of steps the assistant can run). You never act; you only describe the request as JSON.",
    "operation is exactly one of:",
    "- save: store a NEW workflow with a name and steps.",
    "- list: show which workflows exist or when they run.",
    "- delete: throw a saved workflow away completely (the user no longer wants or needs it).",
    "- schedule: make a saved workflow start automatically at a time.",
    "- unschedule: stop a saved workflow from starting automatically; the workflow itself stays saved.",
    "- run: run a saved workflow right now.",
    "- other: anything else, including questions that are not about the user's saved workflows.",
    "- unclear: about workflows, but you cannot tell what is wanted.",
    "workflow_name = the workflow the request is about, written as the user wrote it, or \"\". steps = for save only, the tasks to perform as short requests using the user's own words, else []. ask = a short question if the request is unclear, else \"\". Never invent a name or a step.",
    "The user's saved workflows: " + list + ".",
    "Examples:",
    'Request: Reports ought to stop launching each Friday. -> {"operation":"unschedule","workflow_name":"reports","steps":[],"ask":""}',
    'Request: Reports is obsolete, remove that routine. -> {"operation":"delete","workflow_name":"reports","steps":[],"ask":""}',
    'Request: Nobody uses the reports routine now, get rid of it. -> {"operation":"delete","workflow_name":"reports","steps":[],"ask":""}',
    'Request: Are there any routines I made earlier? -> {"operation":"list","workflow_name":"","steps":[],"ask":""}',
    'Request: Get reports going every Tuesday at 4 pm. -> {"operation":"schedule","workflow_name":"reports","steps":[],"ask":""}',
    'Request: Make a routine called hello that says hi, then tells the time. -> {"operation":"save","workflow_name":"hello","steps":["say hi","tell the time"],"ask":""}',
    'Request: Do something with my workflows. -> {"operation":"unclear","workflow_name":"","steps":[],"ask":"What would you like to do with your workflows?"}',
    'Request: What is the capital of France? -> {"operation":"other","workflow_name":"","steps":[],"ask":""}',
  ].join("\n");
}

export interface RawIntent { operation: string; workflow_name: string; steps: string[]; ask: string }

/** Parse the model's JSON defensively. Anything that is not exactly this shape is a malformed answer (fails safe). */
export function parseRaw(x: unknown): RawIntent | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof o[k] === "string" && (o[k] as string).length <= max ? (o[k] as string) : null);
  const operation = str("operation", 20), workflow_name = str("workflow_name", 40), ask = str("ask", 200);
  if (operation === null || workflow_name === null || ask === null) return null;
  if (!(OPERATIONS as readonly string[]).includes(operation)) return null;
  if (!Array.isArray(o.steps) || o.steps.length > 8 || o.steps.some((s) => typeof s !== "string" || s.length > 300)) return null;
  return { operation, workflow_name, steps: (o.steps as string[]).map((s) => s.trim()).filter(Boolean), ask };
}

export async function askModel(model: LanguageModel, objective: string, known: readonly KnownWorkflow[], signal: AbortSignal): Promise<{ raw: unknown } | { error: string }> {
  try { return { raw: await model.generateJson({ purpose: "plan", system: intentPrompt(known), user: `Request: ${objective}`, signal, schema: INTENT_SCHEMA as never, maxTokens: 300 }) }; }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

// ── the host's side: deterministic evidence from the user's own words ─────────────────────────────────────
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const PERIOD = String.raw`(a\.?m\.?|p\.?m\.?|in\s+the\s+(?:morning|afternoon|evening)|at\s+night|o'?clock|sharp)`;

/** Every clock time the request states, as HH:mm. "noon", "midnight", 9 pm, 9:30, 21:00, nine in the evening; a bare "at 9" is 09:00 (the same rule the exact parser uses). */
export function clockTimes(text: string): { times: string[]; invalid: boolean; vague: boolean; ambiguousHour: boolean } {
  const t = text.toLowerCase();
  const out = new Set<string>(); let invalid = false; let ambiguousHour = false;
  const add = (h: number, m: number, ap?: string) => {
    if (ap) { if (h < 1 || h > 12) { invalid = true; return; } h = (h % 12) + (/^p|afternoon|evening|night/.test(ap) ? 12 : 0); }
    if (h > 23 || m > 59) { invalid = true; return; }
    out.add(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };
  if (/\bnoon\b/.test(t)) out.add("12:00");
  if (/\bmidnight\b/.test(t)) out.add("00:00");
  // Relative forms first: "half past five", "a quarter to six in the evening", "ten past 9 pm". Their span is removed before the plain scan,
  // so "five" in "half past five" is never read as a time of its own.
  const MINS: Record<string, number> = { half: 30, quarter: 15, "a quarter": 15, five: 5, ten: 10, fifteen: 15, twenty: 20, "twenty-five": 25, "twenty five": 25 };
  const rel = new RegExp(String.raw`\b(half|a\s+quarter|quarter|twenty[- ]five|twenty|fifteen|ten|five|\d{1,2}\s+minutes?)\s+(past|after|to|before|till|until)\s+${NUM}\s*${PERIOD}?(?![\d:])`, "g");
  let scan = t;
  for (const m of t.matchAll(rel)) {
    const key = m[1]!.replace(/\s+minutes?$/, "").replace(/\s+/g, " "); const mins = key in MINS ? MINS[key]! : Number(key);
    const h0 = m[3]! in WORDNUM ? WORDNUM[m[3]!]! : Number(m[3]);
    const before = /^(to|before|till|until)$/.test(m[2]!);
    if (!(mins >= 1 && mins <= 59) || h0 < 1 || h0 > 12) { invalid = true; continue; }
    const h = before ? (h0 === 1 ? 12 : h0 - 1) : h0;
    const per = m[4] && /^(a|p|in|at)/.test(m[4]) ? m[4].replace(/\s+/g, " ") : undefined;
    add(h, before ? 60 - mins : mins, per);
    scan = scan.replace(m[0], " ".repeat(m[0].length));
  }
  const MINW: Record<string, number> = { fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, "thirty-five": 35, forty: 40, "forty-five": 45, fifty: 50, "fifty-five": 55 };
  const re = new RegExp(String.raw`(?:\b(at|@|around|by)\s+)?\b${NUM}(?:(?::(\d{2}))|\s+(fifteen|twenty[- ]five|twenty|thirty[- ]five|thirty|forty[- ]five|forty|fifty[- ]five|fifty)(?=\s|$|[.,!?]))?\s*${PERIOD}?(?![\d:])`, "g");
  for (const m of scan.matchAll(re)) {
    const [, at, n, mm0, mw, per] = m;
    const mm = mm0 ?? (mw !== undefined ? String(MINW[mw.replace(/\s+/g, "-")]!) : undefined);
    const hasColon = mm !== undefined;
    // A number is a clock time only with an am/pm-style marker, a colon, or after "at"; so "2+3", "12*12", "the 1st" and "15 minutes" are not.
    if (!per && !hasColon && !at) continue;
    // Part of a longer number ("forty-seven pm"): the tail alone must never be taken as the time.
    if (!at && /(?:\d|\bone|\btwo|\bthree|\bfour|\bfive|\bsix|\bseven|\beight|\bnine|\bten|\beleven|\btwelve|\btwenty|\bthirty|\bforty|\bfifty|-)$/.test(scan.slice(0, m.index ?? 0).trimEnd())) { invalid = true; continue; }
    const after = scan.slice((m.index ?? 0) + m[0].length);
    if (!per && !hasColon && /^\s*(minutes?|mins?|hours?|seconds?|days?|weeks?|months?|%|percent)\b/.test(after)) continue;
    const h = n! in WORDNUM ? WORDNUM[n!]! : Number(n);
    let ap = per && /^(a|p|in|at)/.test(per) ? per.replace(/\s+/g, " ") : undefined;
    // A time must be read WHOLE: a number or number-word glued on right after it ("eight forty-seven", "9 30") is not understood.
    if (/^\s*(?:and\s+)?(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|oh)\b/.test(scan.slice((m.index ?? 0) + m[0].length))) { invalid = true; continue; }
    // A bare hour ("at 7", "at eleven") with no am/pm and no colon is genuinely ambiguous; the user's own morning/evening words decide it, else it is asked.
    if (!ap && mm0 === undefined && mw === undefined && h >= 1 && h <= 12) {
      const am = /\b(morning|a\.?m\.?)\b/.test(t), pm = /\b(afternoon|evening|night|tonight|p\.?m\.?)\b/.test(t);
      if (am !== pm) ap = am ? "am" : "pm"; else { ambiguousHour = true; continue; }
    }
    add(h, hasColon ? Number(mm) : 0, ap);
  }
  const vague = out.size === 0 && !invalid && /\b(morning|evening|afternoon|night|lunchtime|dawn|dusk)\b/.test(t);
  return { times: [...out], invalid, vague, ambiguousHour };
}

export interface Timing { kinds: Set<string>; days: string[]; date: string | null; dateInvalid: boolean; unsupported: string | null }
const todayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function timingOf(text: string, now: Date = new Date()): Timing {
  const t = text.toLowerCase();
  const kinds = new Set<string>(); const days = new Set<string>(); let date: string | null = null; let dateInvalid = false; let unsupported: string | null = null;
  if (/\b(every\s*day|everyday|daily|each\s+(?:day|morning|evening|night|afternoon)|every\s+(?:morning|evening|night|afternoon))\b/.test(t)) kinds.add("daily");
  for (const d of DAYS) if (new RegExp(String.raw`\b${d}s?\b`).test(t)) days.add(d);
  if (days.size && /\b(every|each|weekly|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)days|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/.test(t)) kinds.add("weekly");
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const [, y, mo, d] = iso; const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (dt.getFullYear() === Number(y) && dt.getMonth() === Number(mo) - 1 && dt.getDate() === Number(d)) { date = iso[0]; kinds.add("once"); } else dateInvalid = true;
  } else if (/\btomorrow\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); date = todayStr(d); kinds.add("once"); }
  else if (/\btoday\b|\btonight\b/.test(t) && !/what'?s on/.test(t)) { date = todayStr(now); kinds.add("once"); }
  if (/\bweekdays?\b|\bweekends?\b/.test(t)) unsupported = "I can schedule one weekday at a time (for example every Monday) or every day, not weekdays or weekends as a group.";
  else if (/\bevery\s+other\b|\bbi-?weekly\b|\bfortnight/.test(t)) unsupported = "I can't schedule every other week; I can do every day, one weekday each week, or once on a date.";
  else if (/\bevery\s+\d+\s*(?:minutes?|mins?|hours?|seconds?)\b|\bhourly\b|\bevery\s+(?:minute|hour)\b/.test(t)) unsupported = "I can only schedule at a clock time (every day, one weekday each week, or once), not at intervals.";
  else if (/\b(?:every\s+month|monthly|each\s+month|every\s+year|yearly|annually)\b/.test(t)) unsupported = "I can't schedule monthly or yearly; I can do every day, one weekday each week, or once on a date.";
  return { kinds, days: [...days], date, dateInvalid, unsupported };
}

// Operation evidence: broad word STEMS that must appear in the request for the model's chosen operation to be believed.
const EVIDENCE: Record<string, RegExp> = {
  save: /\b(creat|sav|mak|defin|add|build|new|record|stor|set\s*up|put\s+together|turn\b.*\binto|assembl|compos|writ)/i,
  list: /\b(list|show|what|which|display|see|view|enumerat|overview|tell\s+me|give\s+me|do\s+i\s+have|have\s+i|any|exist|stored|saved|are\s+there)/i,
  delete: /\b(delet|remov|eras|discard|get\s+rid|forget|drop|trash|wipe|scrap|destroy|throw|dump|clear|no\s+longer\s+need|don'?t\s+need|do\s+not\s+need|ditch|purge|obsolete)/i,
  schedule: /\b(schedul|run|execut|start|launch|trigger|fire|kick|go\b|set\s*up|arrange|have|make|every|daily|weekly|each|once|at\s+\d|on\s+20|tomorrow|tonight|automatic|go\s+off)/i,
  unschedule: /\b(unschedul|stop|cancel|disabl|turn\s+off|halt|pause|quit|end|remov|delet|clear|take\b.*\boff|no\s+longer|any\s+longer|anymore|don'?t\s+want|do\s+not\s+want|shouldn'?t|should\s+not|not\s+(?:fire|run)|rather\s+not|kill|off\b|no\s+more|mustn'?t|must\s+not|never\s+again|manually|myself)/i,
};
/** Words that talk about running/scheduling. Delete is the destructive operation, so it needs request wording that is NOT about the schedule; unschedule needs wording that IS. */
const SCHEDULEY = /\b(schedul\w*|unschedul\w*|trigger\w*|every|daily|weekly|each\s+(?:day|week|morning|evening|night)|automatic\w*|recurring|timer|timed|on\s+its\s+own|by\s+itself|run(?:s|ning)?|fire[sd]?|firing|launch\w*|start\w*|keep\s+it|but\s+keep|stay\s+saved)\b/i;
/** A request that points at the user's own saved workflows (plural nouns, or possessive/saved/existing + noun). */
const LISTREF = /\b(workflows|automations|routines|macros)\b|\b(?:my|saved|stored|existing|set\s*up|scheduled|all)\s+(?:workflow|automation|routine|macro)\b/i;
/** Words of stopping/cancelling: a "schedule" reading of a request that has no timing and contains these is doubtful. */
const STOPPY = /\b(stop\w*|cancel\w*|disabl\w+|turn\s+off|halt\w*|pause\w*|quit|no\s+longer|any\s+longer|anymore|don'?t|do\s+not|shouldn'?t|should\s+not|rather\s+not|remov\w+|clear|end|off)\b/i;
/** Primary verbs of DIFFERENT operations in one request: the request asks for more than one thing (or contradicts itself). */
const PRIMARY: Record<string, RegExp> = {
  save: /\b(?:creat(?:e|es|ing)|sav(?:e|es|ing)|defin(?:e|es)|build)\b/i,
  delete: /\b(?:delet(?:e|es|ing)|eras(?:e|es|ing)|discard\w*|get\s+rid\s+of|trash\w*|wipe\w*|forget)\b/i,
  list: /(?<!\b(?:my|the|a|your|that|this)\s+)\b(?:list|show|display)\b/i,
  unschedule: /\b(?:unschedul\w+|cancel\w*|disabl\w+)\b/i,
  // "schedule" as a VERB ("schedule it", "and then schedule"), not the noun ("cancel the schedule", "off its schedule").
  schedule: /(?<!(?:\b(?:the|its|their|his|her|a|my|of|off|from|no|any|this|that)|['’]s)\s+)\bschedul(?:e|es|ing)\b(?!\s+(?:of|for)\b)/i,
};

// Content-word grounding for steps: stem match so "checks my reports" can come from "check my reports".
const STOP = new Set(["the", "and", "then", "that", "this", "with", "for", "from", "into", "onto", "please", "my", "your", "our", "its", "his", "her", "their", "all", "any", "some", "can", "could", "would", "will", "you", "are", "was", "has", "have", "had", "who", "which", "what", "when", "where", "how", "about", "also", "just", "than", "them", "they", "these", "those", "each", "every", "after", "before", "once"]);
const stem = (w: string) => (/ies$/i.test(w) ? w.replace(/ies$/i, "y") : w.replace(/(ing|ed|es|s)$/i, ""));
export function groundedIn(step: string, request: string): boolean {
  const reqStems = words(request).map(stem);
  const content = words(step).filter((w) => w.length >= 3 && !STOP.has(w));
  if (content.length === 0) return false;
  return content.every((w) => { const s = stem(w); return reqStems.some((r) => r === s || (s.length >= 4 && r.length >= 4 && (r.startsWith(s) || s.startsWith(r)))); });
}

const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;
const list = (k: readonly KnownWorkflow[]) => k.map((w) => `"${w.name}"`).join(", ");
const ONE_THING = "I can do one workflow operation per request. Please ask for one thing at a time.";

/** Resolve the workflow the request means among the user's saved ones. Never guesses: partial overlap or several candidates is a question. */
function resolve(objective: string, modelName: string, known: readonly KnownWorkflow[]): { name: string } | { clarify: string } {
  if (known.length === 0) return { clarify: "You have no saved workflows yet." };
  const mentioned = known.filter((k) => mentions(objective, k.name));
  const clean = (s: string) => s.toLowerCase().replace(/["“”'`]/g, "").replace(/\b(the|my|a|an|old|workflow|automation|routine)\b/g, "").replace(/\s+/g, " ").trim();
  const claimed = known.find((k) => clean(k.name) === clean(modelName) || k.name.toLowerCase() === modelName.trim().toLowerCase());
  if (mentioned.length > 1) {
    // "backup" next to "backup-weekly": a name that is only part of another mentioned name does not count as a second target.
    const maximal = mentioned.filter((a) => !mentioned.some((b) => b !== a && b.name.toLowerCase().includes(a.name.toLowerCase())));
    if (maximal.length === 1) return { name: maximal[0]!.name };
    return { clarify: `Which workflow do you mean: ${list(mentioned)}?` };
  }
  if (mentioned.length === 1) {
    // The model named a different saved workflow than the one the user wrote: not unambiguous.
    if (claimed && claimed.name !== mentioned[0]!.name && !mentioned[0]!.name.toLowerCase().includes(claimed.name.toLowerCase())) return { clarify: `Which workflow do you mean: ${list([mentioned[0]!, claimed])}?` };
    return { name: mentioned[0]!.name };
  }
  // No saved name appears whole in the request: offer candidates that share a word, never pick one.
  const reqWords = new Set(words(objective).filter((w) => w.length >= 3 && !STOP.has(w)));
  const near = known.filter((k) => words(k.name).some((w) => w.length >= 3 && reqWords.has(w)));
  if (near.length) return { clarify: `I don't have a workflow with exactly that name. Did you mean ${list(near)}? Please repeat the request with the full name.` };
  return { clarify: `I couldn't find which workflow you mean. Your workflows: ${list(known)}.` };
}

export function validateIntent(raw: unknown, objective: string, known: readonly KnownWorkflow[], now: Date = new Date()): Intent {
  const r = parseRaw(raw);
  if (!r) return { kind: "clarify", question: "I couldn't understand that request well enough to act on it. Please say it again, for example: \"Unschedule the workflow NAME\" or \"Schedule the workflow NAME every day at 9:00\"." };
  const q = (question: string): Intent => ({ kind: "clarify", question });
  let op: string = r.operation;
  const text = masked(objective, [...known.map((k) => k.name), r.workflow_name]);   // evidence is read from the request minus workflow names
  if (op === "run") { const tm = timingOf(text, now); if (tm.kinds.size > 0 || tm.unsupported) op = "schedule"; }   // "run X every day at 9" is a schedule, as in the exact parser
  if (op === "other" || op === "run") return { kind: "none" };
  if (op === "unclear") return q(r.ask.trim() || "I couldn't tell what you want to do with your workflows. Do you want to save, list, delete, schedule or unschedule one?");

  // More than one operation asked for, or a request that contradicts itself.
  const primaries = Object.entries(PRIMARY).filter(([, re]) => re.test(text)).map(([k]) => k);
  if (primaries.length > 1) return q(ONE_THING);
  // The chosen operation may not contradict the one verb the user used ("wipe ... from my list" is not a list request).
  if (primaries.length === 1 && primaries[0] !== op) return q(`I wasn't sure whether you meant to ${primaries[0]} a workflow or to ${op} one. Please say which, for example: "${primaries[0] === "delete" ? "Delete" : primaries[0] === "save" ? "Save a workflow called NAME:" : primaries[0] === "list" ? "List" : primaries[0] === "unschedule" ? "Unschedule" : "Schedule"} the workflow ...".`);
  if (/\b(delet\w*|remov\w*|erase|discard)\b.*\bbut\b.*\bkeep\b|\bkeep\b.*\bbut\b.*\b(delet\w*|remov\w*)/i.test(text)) return q("That asks to delete the workflow and keep it. Do you want to delete it, or only stop its schedule?");
  // "...but make sure it runs every day": a contrast that re-asserts running/scheduling contradicts a stop/delete request. (A plain "but keep it" does not.)
  if (["delete", "unschedule", "schedule"].includes(op)) {
    const tail = text.match(/\b(?:but|however|except|although|though|unless)\b(.*)$/i)?.[1];
    if (tail && /\b(every|daily|weekly|each|runs?|running|schedul\w*|at\s+\d|automatic\w*)\b/i.test(tail)) return q("That request has two parts that pull in different directions (for example stopping a workflow and keeping it running). Please ask for one thing at a time.");
  }
  // The chosen operation must be supported by the request's own words.
  if (!EVIDENCE[op]!.test(text)) return q(`I wasn't sure you meant to ${op} a workflow. Please say what you want to do with it.`);

  if (op === "list") {
    // Listing is read-only, but the request must actually be about the user's saved workflows (not, say, a question about a word).
    if (!LISTREF.test(text)) return q("Do you want me to list your saved workflows? Say \"List my workflows\".");
    return { kind: "call", op: "list", args: {} };
  }

  if (op === "save") {
    const name = r.workflow_name.trim();
    if (!name) return q("What do you want to call the new workflow? For example: Save a workflow called NAME: first step; then second step.");
    if (!NAME_OK.test(name) || /[ .]$/.test(name)) return q("A workflow name is 1 to 40 letters, digits, spaces, '.', '_' or '-'. What should it be called?");
    if (!explicitlyNamed(objective, name)) return q(`You didn't name this workflow ("${name}" is just a word in your request). What do you want to call it? For example: Save a workflow called NAME: first step; then second step.`);
    if (known.some((k) => k.name.toLowerCase() === name.toLowerCase())) return q(`A workflow called "${name}" already exists. Delete it first, or choose another name.`);
    const steps = r.steps;
    if (steps.length === 0) return q(`What should "${name}" do? Please list its steps, for example: Save a workflow called ${name}: first step; then second step.`);
    if (steps.length > 8) return q("A workflow has at most 8 steps.");
    for (const s of steps) {
      if (s.length < 3 || s.length > 300 || /[\u0000-\u001f‪-‮⁦-⁩]/.test(s) || /\bworkflow\b|\bschedul/i.test(s)) return q("Each step must be a plain request of 3 to 300 characters that does not run or schedule workflows. Please restate the steps.");
      if (!groundedIn(s, objective)) return q(`I wasn't sure about the step "${s}" because it uses words you didn't say. Please spell the steps out, for example: Save a workflow called ${name}: first step; then second step.`);
    }
    const t = timingOf(text, now), c = clockTimes(text);
    const hint = t.kinds.size || c.times.length ? `To run it automatically, say: "Schedule the workflow ${name} every day at 9:00" (I saved it without a schedule).` : undefined;
    return { kind: "call", op: "save", args: { name, steps }, note: hint };
  }

  // delete / schedule / unschedule act on an existing workflow
  const res = resolve(objective, r.workflow_name, known);
  if ("clarify" in res) return q(res.clarify);
  const target = known.find((k) => k.name === res.name)!;
  const eitherOr = `Do you want to delete the workflow "${target.name}" entirely, or only stop it from running automatically? Say "Delete the workflow ${target.name}" or "Unschedule the workflow ${target.name}".`;

  if (op === "delete") {
    if (SCHEDULEY.test(text)) return q(eitherOr);
    // Delete is destructive: a name that is also a whole word of another saved workflow's name ("backup" and "backup-weekly") must be confirmed.
    const lookalike = known.filter((k) => k.name !== target.name && new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(target.name)}(?![\p{L}\p{N}])`, "iu").test(k.name));
    if (lookalike.length) return q(`You have ${list([target, ...lookalike])}. Which one should I delete? Please say the full name, for example: Delete the workflow "${target.name}".`);
    return { kind: "call", op: "delete", args: { name: target.name } };
  }
  if (op === "unschedule") {
    // "I no longer need X" says nothing about X's schedule: that is a delete wish or unclear, never silently an unschedule.
    if (!SCHEDULEY.test(text)) return q(eitherOr);
    if (/\b(delet\w+|eras\w+|discard\w*|trash\w*|wipe\w*)\b/i.test(text)) return q(eitherOr);
    return { kind: "call", op: "unschedule", args: { name: target.name } };
  }

  // schedule: the host derives repeat / day / date / time from the request itself (a closed, formal domain).
  const t = timingOf(text, now), c = clockTimes(text);
  if (t.unsupported) return q(t.unsupported);
  if (t.dateInvalid) return q("That date doesn't exist. Please give a real date as yyyy-mm-dd.");
  if (t.days.length > 1) return q("Please name one weekday per schedule. For several days, ask for one schedule at a time.");
  if (t.kinds.size > 1) return q("That asks for more than one kind of schedule (for example every day and every Monday). Please ask for one schedule.");
  if (c.invalid) return q("I couldn't read that time with certainty. Please give it as, for example, 9:00 or 9 PM.");
  if (c.ambiguousHour) return q(`Is that AM or PM? Please say, for example, "at 7 AM" or "at 7 PM" (or use 24-hour time such as 19:00).`);
  if (t.kinds.size === 0 && c.times.length === 0 && STOPPY.test(text)) return q(`Do you want to schedule the workflow "${target.name}", or stop it from running automatically? Say "Unschedule the workflow ${target.name}" or "Schedule the workflow ${target.name} every day at 9:00".`);
  if (t.kinds.size === 0) return q(`When should "${target.name}" run: every day, on one weekday each week, or once on a date? Please give a clock time too.`);
  const kind = [...t.kinds][0]!;
  if (c.times.length === 0) return q(c.vague ? `What exact time should "${target.name}" run? "Morning" or "evening" isn't a clock time; for example 9:00 or 9 PM.` : `What time should "${target.name}" run? For example 9:00 or 9 PM.`);
  if (c.times.length > 1) return q("That names more than one time. Please give one clock time per schedule.");
  const args: Record<string, unknown> = { name: target.name, kind, time: c.times[0]! };
  if (kind === "weekly") { if (!t.days[0]) return q("Which weekday? For example every Monday."); args.day = t.days[0]; }
  if (kind === "once") { if (!t.date) return q("Which date? Please give it as yyyy-mm-dd."); args.date = t.date; }
  return { kind: "call", op: "schedule", args };
}
