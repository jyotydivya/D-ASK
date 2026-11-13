// ─────────────────────────────────────────────────────────────────────────────
// Result passing between capabilities ("composition"), without giving the model any new authority.
//
//   "<request>, then save it as a note called T"     run <request>, then save its result as note T
//   "<request> and remember it"                       run <request>, then remember its result
//   "save that as a note called T" / "remember that"  the same, with the PREVIOUS result (this conversation, or the previous
//                                                     workflow step)
//
// The first part runs exactly as if it had been typed alone (any capability: knowledge, research, files, browser, OCR, …).
// Its result then becomes the LITERAL text of an ordinary second request ("Create a note titled T containing \"…\"" /
// "Remember that …"), which goes through the same runtime: the notes/memory grammars, grounding, the daemon's approval card
// showing the exact text, secret refusal, Emergency Stop and the independent file check all apply unchanged. Nothing is
// saved if the first part did not succeed. Deterministic: no model decides what is chained or what is saved.
// ─────────────────────────────────────────────────────────────────────────────

import type { Artifact, RunOutcome, RuntimeEvent } from "../runtime/types";
import { sourceLines } from "../runtime/artifact";
import { MAX_NOTE_TEXT, isSafeNoteTitle, noteTextProblem } from "../runtime/tools/notes";
import { MAX_CONTENT_CHARS, secretIn } from "../runtime/memory/memoryStore";
import type { TaskResult } from "./host";

/**
 * Where a result can go. Each destination is an ORDINARY request with its own grammar and safety:
 *   note       "Create a note titled T containing \"…\""   (daemon approval card shows the exact text; file checked independently)
 *   memory     "Remember that …"                          (secrets refused; local only)
 *   notepad    "Open Notepad and type \"…\""                (two approval cards: open, then the exact text; UIA-verified)
 *   knowledge  "Index the page <url> into web"           (only for a web page the user had D-ASK read; re-read and indexed with its URL)
 */
export type Sink = { kind: "note"; title: string } | { kind: "memory" } | { kind: "notepad" } | { kind: "knowledge" };
export interface Chain { source: string | null; sink: Sink }

const IT = String.raw`(?:it|that|this|them|the\s+(?:answer|result|results|summary|report|reply|response|text|findings|output|list|passages|page))`;
const NOTE_TAIL = String.raw`(?:save|store|write|put|keep|copy)\s+${IT}\s+(?:in|into|to|as)\s+(?:a\s+|an\s+)?(?:new\s+)?note\s+(?:titled|called|named)\s+["“']?([\p{L}\p{N}][\p{L}\p{N} _'&()+,.-]{0,59}?)["”']?\s*[.!]?\s*$`;
const MEM_TAIL = String.raw`remember\s+${IT}\s*[.!]?\s*$`;
const PAD_TAIL = String.raw`(?:type|write|put|enter)\s+${IT}\s+(?:in|into)\s+(?:a\s+new\s+|the\s+)?notepad\s*[.!]?\s*$`;
const KB_TAIL = String.raw`(?:add|save|put|index)\s+${IT}\s+(?:to|into|in)\s+(?:my\s+|the\s+)?(?:knowledge(?:\s+base)?|web\s+collection|index)\s*[.!]?\s*$`;
const JOIN = String.raw`\s*[,;]?\s+(?:and\s+)?(?:then\s+)?(?:also\s+)?`;
const FOLLOW = String.raw`^\s*(?:please\s+)?(?:now\s+)?(?:also\s+)?`;
const SINKS: { tail: string; sink: (m: RegExpExecArray, at: number) => Sink }[] = [
  { tail: NOTE_TAIL, sink: (m, at) => ({ kind: "note", title: m[at]!.trim() }) },
  { tail: MEM_TAIL, sink: () => ({ kind: "memory" }) },
  { tail: PAD_TAIL, sink: () => ({ kind: "notepad" }) },
  { tail: KB_TAIL, sink: () => ({ kind: "knowledge" }) },
];
const FOLLOW_RE = SINKS.map((x) => ({ re: new RegExp(FOLLOW + x.tail, "iu"), sink: x.sink }));
const CHAIN_RE = SINKS.map((x) => ({ re: new RegExp(String.raw`^(.{3,}?)${JOIN}${x.tail}`, "iu"), sink: x.sink }));

/** The chain a request asks for, or null (then the request runs as it always did). */
export function parseChain(objective: string): Chain | null {
  const o = objective.trim();
  // Defining or scheduling a workflow: its steps are TEXT to be stored (a step may itself say "save that as a note"), never run here.
  if (/^\s*(?:please\s+)?(?:save|create|make|define|add|schedule|run|update|edit)\b[^:]{0,60}\bworkflows?\b/i.test(o)) return null;
  let m: RegExpExecArray | null;
  for (const f of FOLLOW_RE) if ((m = f.re.exec(o))) return { source: null, sink: f.sink(m, 1) };
  for (const c of CHAIN_RE) if ((m = c.re.exec(o))) return { source: m[1]!.trim().replace(/[,;]$/, ""), sink: c.sink(m, 2) };
  return null;
}

/** Outcomes whose result may be passed on. */
export const PASSABLE: ReadonlySet<RunOutcome> = new Set(["completed", "answered", "unverified"]);

const clean = (t: string) => t.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");

/** The text of a result as it will be saved: quotes made unambiguous for the note grammar, control characters removed. */
export function resultText(response: string, forMemory: boolean): string {
  let t = clean(response).replace(/["“”]/g, "'");
  if (forMemory) t = t.replace(/\n(?:Sources|Closest passages):\n[\s\S]*$/, "").replace(/\s*\[\d{1,2}\]/g, "").replace(/\s*\n\s*/g, "; ");
  return t.trim();
}

// The subject of a knowledge question: "when is the de-ask evaluation deadline" -> "D-ASK evaluation deadline". Only a leading question head
// is removed; the rest is the user's own words. The product's own name is written one way (speech recognition spells it de-ask, dask, …).
const QUESTION_HEAD = /^(?:when|what|where|who|which|how\s+(?:much|many|long|old))(?:'s|\s+(?:is|are|was|were|will\s+be))\s+(?:(?:the|my|our|a|an)\s+)?/i;
const PRODUCT_NAME = /\b(?:d[\s.-]?a[\s.]?s[\s.]?k|de[\s-]?ask(?:ed)?)\b/gi;
export function subjectOf(question: string): string {
  const q = question.trim().replace(/[?.!\s]+$/, "").replace(QUESTION_HEAD, "");
  return q.replace(PRODUCT_NAME, "D-ASK").replace(/["“”]/g, "'").replace(/:/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** An artifact from a bare response (results produced before artifacts existed, tests). */
export function textArtifact(response: string, outcome: RunOutcome, objective = ""): Artifact {
  return { kind: "text", text: response, sources: [], provenance: { tool: "runtime", objective, outcome, verified: null, online: false, at: new Date().toISOString() } };
}

/** The second, ordinary request that passes the artifact on; or why it cannot be built (nothing is done then). */
export function sinkObjective(sink: Sink, a: Artifact): { objective: string } | { refuse: string } {
  if (sink.kind === "note") {
    if (!isSafeNoteTitle(sink.title)) return { refuse: `"${sink.title}" cannot be used as a note title (letters, digits, spaces and simple punctuation, at most 60 characters).` };
    const text = resultText(a.text + sourceLines(a) + (a.provenance.online ? `\n(Read from the web ${a.provenance.at.slice(0, 16).replace("T", " ")} UTC.)` : ""), false);
    if (text.length > MAX_NOTE_TEXT) return { refuse: `The result is ${text.length} characters; a note holds at most ${MAX_NOTE_TEXT}. Nothing was saved.` };
    const p = noteTextProblem(text);
    if (p) return { refuse: `Nothing was saved: ${p}.` };
    return { objective: `Create a note titled ${sink.title} containing "${text}"` };
  }
  if (sink.kind === "memory") {
    // A knowledge answer is remembered only when the code's citation check tied EVERY sentence to a retrieved passage: a partly
    // supported answer (sentences marked "model inference"), an insufficient one, or bare extracts are not stored as facts.
    if (a.provenance.tool === "knowledge.answer" && a.provenance.grounding !== "grounded") {
      return { refuse: `I won't remember that: the answer is not fully supported by your documents (${a.provenance.grounding ?? "unchecked"}). Nothing was saved.` };
    }
    let text = resultText(a.text, true);
    // Keep what the answer is ABOUT (from the user's own question), so it can be found again: "16 November 2026" alone matches no question.
    const subject = a.provenance.tool === "knowledge.answer" && a.provenance.question ? subjectOf(a.provenance.question) : "";
    if (subject.length >= 2) text = `${subject}: ${text}`;
    if (a.sources.length === 1 && a.kind !== "memory") text += ` (source: ${a.sources[0]!.label.replace(/["“”]/g, "'").slice(0, 80)})`;
    if (text.length < 2) return { refuse: "There is nothing to remember. Nothing was saved." };
    if (text.length > MAX_CONTENT_CHARS) return { refuse: `The result is ${text.length} characters; a memory holds at most ${MAX_CONTENT_CHARS}. Save it as a note instead ("save it as a note called …"). Nothing was saved.` };
    const secret = secretIn(text);
    if (secret) return { refuse: `I won't remember that: it looks like ${secret}, and D-ASK never stores those.` };
    return { objective: `Remember that ${text}` };
  }
  if (sink.kind === "notepad") {
    // The Notepad grammar takes ONE quoted text of at most 200 characters on one line. Apostrophes and double quotes become look-alike letters
    // (U+02BC, U+02BA) so the quoting stays unambiguous; the typing card shows the exact characters before anything is typed.
    const text = clean(a.text).replace(/\n(?:Sources|Closest passages):\n[\s\S]*$/, "").replace(/\s*\[\d{1,2}\]/g, "").replace(/\s*\n\s*/g, " ").replace(/['‘’]/g, "ʼ").replace(/["“”]/g, "ʺ").trim();
    if (!text) return { refuse: "There is nothing to type. Nothing was typed." };
    if (text.length > 200) return { refuse: `The result is ${text.length} characters; D-ASK types at most 200 into Notepad. Save it as a note instead ("save it as a note called …"). Nothing was typed.` };
    return { objective: `Open Notepad and type "${text}"` };
  }
  // knowledge: only a web page the user had D-ASK read (its URL is the source); files are indexed by folder.
  if (a.kind !== "page" || !a.sources[0] || !/^https?:\/\//i.test(a.sources[0].ref)) return { refuse: "Only a web page D-ASK has read can be added to your knowledge this way. To index files, say \"index <folder> as <name>\". Nothing was added." };
  return { objective: `Index the page ${a.sources[0].ref} into web` };
}

export interface ChainDeps {
  /** Runs one ordinary request (the same path as typing it). `stepPrefix` renames its step ids so two runs never collide. */
  run(objective: string, stepPrefix: string): Promise<TaskResult>;
  /** The result to use when the request refers to "that" (previous turn / previous workflow step); null when there is none. */
  previous: { objective: string; result: TaskResult } | null;
  taskId: string;
  /** The task's abort signal (cancel / Emergency Stop): checked between the two parts, so a stop after the first part starts nothing more. */
  signal?: AbortSignal;
}

const SINK_LABEL = (s: Sink) => s.kind === "note" ? `note "${s.title}"` : s.kind === "memory" ? "memory" : s.kind === "notepad" ? "text typed into Notepad" : "your web knowledge";

/** Runs a parsed chain. Fail-closed: nothing is passed on unless the first part succeeded and the second request is valid. */
export async function runChain(chain: Chain, deps: ChainDeps): Promise<TaskResult> {
  const base = (outcome: RunOutcome, response: string, extra: Partial<TaskResult> = {}): TaskResult =>
    ({ taskId: deps.taskId, outcome, response, iterations: 0, toolCalls: 0, error: null, steps: [], verification: null, ...extra });
  let first: TaskResult;
  let firstLabel: string;
  if (chain.source === null) {
    if (!deps.previous) return base("refused", "There is no earlier result in this conversation to use. Ask for something first, then say \"save that as a note called …\", \"remember that\", \"type it into Notepad\" or \"add it to my knowledge\".");
    first = deps.previous.result;
    firstLabel = `the previous result ("${deps.previous.objective.slice(0, 80)}")`;
    if (!PASSABLE.has(first.outcome)) return base("refused", `The previous request ended ${first.outcome.toUpperCase()}, so there is no result to use. Nothing was done.`);
  } else {
    first = await deps.run(chain.source, "");
    firstLabel = `"${chain.source.slice(0, 80)}"`;
    if (!PASSABLE.has(first.outcome)) {
      return { ...first, response: `${first.response}\n\nNothing was passed on: the first part ended ${first.outcome.toUpperCase()}.` };
    }
  }
  const artifact = first.artifact ?? textArtifact(first.response, first.outcome, deps.previous?.objective ?? chain.source ?? "");
  if (deps.signal?.aborted) {
    return { ...first, outcome: "cancelled", artifact, response: `${chain.source === null ? "" : first.response + "\n\n"}Stopped before passing the result on (cancelled or Emergency Stop). Nothing more was done.` };
  }
  const built = sinkObjective(chain.sink, artifact);
  if ("refuse" in built) {
    return { ...first, outcome: chain.source === null ? "refused" : "partial", response: `${chain.source === null ? "" : first.response + "\n\n"}${built.refuse}`, steps: chain.source === null ? [] : first.steps };
  }
  const second = await deps.run(built.objective, "save.");
  const done = second.outcome === "completed";
  const what = SINK_LABEL(chain.sink);
  const outcome: RunOutcome = done ? (chain.source === null ? "completed" : first.outcome === "completed" ? "completed" : "unverified") : second.outcome === "cancelled" ? "cancelled" : chain.source === null ? second.outcome : "partial";
  const head = chain.source === null ? "" : `${first.response}\n\n`;
  const prov = `${artifact.kind}${artifact.sources.length ? ` from ${artifact.sources.slice(0, 3).map((s) => s.label).join("; ")}` : ""}${artifact.provenance.online ? " (online)" : ""}`;
  const tail = done
    ? `Saved the result of ${firstLabel} [${prov}] as ${what}${second.verification?.independentlyVerified ? " (checked: it holds exactly that text)" : ""}.`
    : `The result of ${firstLabel} was NOT saved as ${what}: ${second.outcome.toUpperCase()}. ${second.response}`;
  return {
    taskId: deps.taskId, outcome, response: head + tail,
    iterations: (chain.source === null ? 0 : first.iterations) + second.iterations,
    toolCalls: (chain.source === null ? 0 : first.toolCalls) + second.toolCalls,
    error: second.error ?? (chain.source === null ? null : first.error),
    steps: [...(chain.source === null ? [] : first.steps), ...second.steps],
    // The receiving step's verification (the note file / memory row / typed text checked independently). The first part's own status is in its steps and text.
    verification: second.verification,
    // The same artifact stays available: "save that as a note" right after "type it into Notepad" passes the original result, not the confirmation.
    artifact,
  };
}

/** Step ids of a chain's second part get a prefix, so its progress and result never collide with the first part's. */
export function withPrefix(r: TaskResult, prefix: string): TaskResult {
  return prefix ? { ...r, steps: r.steps.map((s) => ({ ...s, id: prefix + s.id })), verification: r.verification && { ...r.verification, grounding: r.verification.grounding.map((g) => ({ ...g, stepId: prefix + g.stepId })) } } : r;
}
export function prefixEvents(emit: (e: RuntimeEvent) => void, prefix: string): (e: RuntimeEvent) => void {
  return (e) => {
    switch (e.type) {
      case "plan": return emit({ ...e, plan: { ...e.plan, steps: e.plan.steps.map((s) => ({ ...s, id: prefix + s.id, dependsOn: s.dependsOn.map((d) => prefix + d) })) } });
      case "step.started": case "step.finished": case "approval.denied": return emit({ ...e, stepId: prefix + e.stepId });
      case "verification": return emit({ ...e, report: { ...e.report, grounding: e.report.grounding.map((g) => ({ ...g, stepId: prefix + g.stepId })) } });
      default: return emit(e);
    }
  };
}
