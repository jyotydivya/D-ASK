// ─────────────────────────────────────────────────────────────────────────────
// KnowledgeService: the ONE local RAG engine (collections, indexing, hybrid retrieval, grounded answers, Research Mode),
// reached through the same task path as every other request (typed, voice, workflow steps, scheduled runs): the agent host's
// runtime wrapper offers each objective here first; anything this grammar does not claim goes to the normal planner unchanged.
//
// Understanding is deterministic (no model decides what is indexed, removed or searched). The local model is used only to
// WRITE answers from retrieved passages, and its citations are validated (ground.ts). Indexing reads only folders inside the
// allowed knowledge roots; removing from the index never touches the user's files. Cancellation and Emergency Stop arrive as the
// task's abort signal and stop indexing, retrieval and generation.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveRoots, relativeInside, type FileRoot } from "../tools/fileAccess";
import type { Artifact, ArtifactSource, LanguageModel, Plan, RunOutcome, RunReport, RuntimeEvent, StepState, VerificationReport } from "../types";
import type { Embedder } from "./embedder";
import { generateGrounded, type GroundedAnswer } from "./ground";
import { docIdOf, indexCollection, resolveIndexFolder, type IndexReport } from "./indexer";
import { chunkDocument } from "./chunk";
import { parseWebPage } from "./extract";
import { defaultResearchDir, findProject, listProjects, REPORT_TITLES, runResearch, type ReportType } from "./research";
import { citation, retrieve, type Passage } from "./retrieve";
import type { Collection, CollectionKind, KnowledgeStore } from "./store";

// ── Request grammar ─────────────────────────────────────────────────────────

export type Scope = { kind: "all" } | { kind: "type"; type: CollectionKind } | { kind: "named"; name: string };
export type KnowledgeIntent =
  | { op: "index"; folder: string | null; collection: string; kind: CollectionKind }
  | { op: "reindex"; collection: string | "*" }
  | { op: "list" }
  | { op: "list-docs"; collection: string }
  | { op: "drop"; collection: string }
  | { op: "remove-path"; path: string }
  | { op: "search"; query: string; scope: Scope }
  | { op: "ask"; question: string; scope: Scope }
  | { op: "research"; topic: string; question: string; type: ReportType; scope: Scope; latest: boolean; urls?: string[] }
  /** Optional, online: read web pages the user NAMED and index them (collection "web" by default), each cited by its URL. */
  | { op: "index-page"; urls: string[]; collection: string }
  | { op: "research-list" }
  | { op: "research-show"; name: string }
  | { op: "research-resume"; name: string };

const P = String.raw`^\s*(?:please\s+)?(?:(?:hey\s+)?d-?ask,?\s+)?`;
const END = String.raw`\s*[.!?]?\s*$`;
const PATH = String.raw`(?:"([^"]+)"|'([^']+)'|([A-Za-z]:\\[^\n"']*?))`;
const CNAME = String.raw`["']?([A-Za-z0-9][\w .-]{0,38}?)["']?`;
// "my documents", "the codebase", "my research papers", "the collection X", "my X collection"
const SRC = String.raw`(?:(?:the\s+)?collection\s+${CNAME}|(?:my|the|our)\s+${CNAME}\s+collection|(?:my|the|our)\s+(?:indexed\s+|local\s+)?(documents?|docs|files|notes|papers|research(?:\s+papers|\s+folder|\s+documents)?|knowledge(?:\s+base)?|sources|codebase|code\s?base|code|repo(?:sitory)?|project(?:'s)?\s+(?:code|source)))`;
// Another subsystem's action in the same request: not claimed here (the planner handles, or refuses, the whole request).
const OTHER_ACTION = /\b(?:and|then)\s+(?:also\s+)?(?:open|type|click|send|e-?mail|delete|move|rename|launch|schedule|remind|copy)\b/i;
const QUESTION_HEAD = /^\s*(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|does|do|did|can|could|should|explain|summari[sz]e|describe|compare|list|tell\s+me|give\s+me|find\s+out)\b/i;

const RE = {
  // "index the page https://… [and https://…] [into web]", "add the web page https://… to my knowledge"
  indexPage: new RegExp(`${P}(?:index|add|save|ingest|read\\s+and\\s+index)\\s+(?:the\\s+)?(?:web\\s*)?(?:pages?|sites?|urls?|articles?)\\s+((?:https?:\\/\\/\\S+?(?:\\s*,\\s*|\\s+and\\s+)?)+?)(?:\\s+(?:into|to|as|in)\\s+(?:the\\s+|my\\s+)?(?:(?:collection\\s+)?${CNAME}(?:\\s+collection)?|knowledge(?:\\s+base)?))?${END}`, "i"),
  indexCode: new RegExp(`${P}(?:index|learn|ingest)\\s+(?:the|this|my|our)\\s+(?:codebase|code\\s?base|repo(?:sitory)?|project(?:\\s+code)?|source\\s+code)${END}`, "i"),
  index: new RegExp(`${P}(?:index|ingest|add|learn(?:\\s+from)?)\\s+(?:the\\s+|my\\s+)?(?:folder\\s+|directory\\s+|(?:files|documents|papers)\\s+in\\s+)?${PATH}(?:\\s+(?:into|to|as|in|under)\\s+(?:the\\s+|my\\s+)?(?:collection\\s+)?${CNAME}(?:\\s+collection)?)?${END}`, "i"),
  reindex: new RegExp(`${P}(?:re-?index|refresh|update|rescan|sync)\\s+(?:the\\s+|my\\s+)?(?:knowledge\\s+)?(?:collection\\s+)?${CNAME}(?:\\s+collection)?${END}`, "i"),
  list: new RegExp(`${P}(?:(?:list|show)(?:\\s+me)?(?:\\s+(?:all|my|the))*\\s+(?:knowledge\\s+)?(?:collections|knowledge(?:\\s+base)?|indexed\\s+(?:folders|documents|files))|(?:knowledge(?:\\s+base)?|index(?:ing)?|rag)\\s+status|what\\s+(?:have|did)\\s+you\\s+index(?:ed)?|what(?:'s|\\s+is)\\s+in\\s+(?:my|the)\\s+knowledge(?:\\s+base)?)${END}`, "i"),
  listDocs: new RegExp(`${P}(?:list|show)(?:\\s+me)?\\s+(?:the\\s+|all\\s+)?(?:documents|files|papers)\\s+in\\s+(?:the\\s+|my\\s+)?(?:collection\\s+)?${CNAME}(?:\\s+collection)?${END}`, "i"),
  drop: new RegExp(`${P}(?:remove|delete|drop|forget)\\s+(?:the\\s+|my\\s+)?(?:(?:knowledge\\s+)?collection\\s+${CNAME}|${CNAME}\\s+collection)${END}`, "i"),
  removePath: new RegExp(`${P}(?:remove|forget|un-?index|drop)\\s+(?:the\\s+)?(?:file|document|folder\\s+)?\\s*${PATH}\\s+from\\s+(?:my\\s+|the\\s+)?(?:knowledge(?:\\s+base)?|index|collections?\\b.*?)${END}`, "i"),
  searchA: new RegExp(`${P}search\\s+(?:in\\s+|through\\s+)?${SRC}\\s+(?:for|about)\\s+(.+?)${END}`, "i"),
  searchB: new RegExp(`${P}(?:search|find(?:\\s+passages)?|look\\s+up)\\s+(?:for\\s+|about\\s+)?(.+?)\\s+in\\s+${SRC}${END}`, "i"),
  askA: new RegExp(`${P}(?:according\\s+to|based\\s+on|using(?:\\s+only)?|from)\\s+${SRC}\\s*[,:]?\\s+(.+?)${END}`, "i"),
  askB: new RegExp(`^(.+?)\\s*,?\\s+(?:according\\s+to|based\\s+on|using(?:\\s+only)?|from|in)\\s+${SRC}${END}`, "i"),
  askC: new RegExp(`${P}ask\\s+${SRC}\\s*[,:]?\\s+(.+?)${END}`, "i"),
  askCode: /^\s*(?:how|where|what|which|why|explain|show\s+me\s+how|describe)\b.+\b(?:in|of|does)\s+(?:this|the|our|my)\s+(?:codebase|code\s?base|repo(?:sitory)?|project(?:'s)?\s+(?:code|source))\b/i,
  researchList: new RegExp(`${P}(?:list|show)(?:\\s+me)?(?:\\s+(?:my|all|the))*\\s+research(?:\\s+projects|\\s+reports)?${END}`, "i"),
  researchResume: new RegExp(`${P}(?:resume|continue|re-?run|refresh|update)\\s+(?:the\\s+|my\\s+)?research(?:\\s+project)?\\s+(?:on\\s+|about\\s+|called\\s+|named\\s+)?["']?(.+?)["']?${END}`, "i"),
  researchShow: new RegExp(`${P}(?:open|show)\\s+(?:the\\s+|my\\s+)?research(?:\\s+project|\\s+report)\\s+(?:on\\s+|about\\s+|called\\s+|named\\s+)?["']?(.+?)["']?${END}`, "i"),
  researchVerb: new RegExp(`${P}(?:research|investigate|do\\s+(?:some\\s+|a\\s+)?research\\s+(?:on|about|into))\\s+(.+?)${END}`, "i"),
  reportPhrase: /\b(literature\s+review|research\s+report|comparative\s+(?:report|analysis)|comparison\s+report|technical\s+summary|gap\s+analysis|research\s+gaps?|compare\s+(?:their|the)\s+methodolog\w*|methodology\s+comparison)\b/i,
};

function scopeOf(m: RegExpExecArray, i: number): Scope {
  const named = m[i] ?? m[i + 1];
  if (named) return { kind: "named", name: named.trim() };
  const w = (m[i + 2] ?? "").toLowerCase();
  if (/code|repo|project/.test(w)) return { kind: "type", type: "code" };
  if (/paper|research/.test(w)) return { kind: "type", type: "research" };
  return { kind: "all" };
}
const pathOf = (m: RegExpExecArray, i: number) => (m[i] ?? m[i + 1] ?? m[i + 2] ?? "").trim().replace(/[\\/]+$/, "");

export function kindForName(name: string): CollectionKind {
  if (/research|paper|literature|thesis/i.test(name)) return "research";
  if (/code|repo|project|source/i.test(name)) return "code";
  if (/personal|document|docs|notes|knowledge|home|private/i.test(name)) return "personal";
  return "folder";
}
function collectionNameOf(raw: string | undefined, folder: string): string {
  const n = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!n || /^(knowledge(-base)?|index|documents?|docs|my-documents)$/.test(n)) return raw ? "documents" : path.basename(folder).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "documents";
  return n.replace(/[^a-z0-9._-]+/g, "-").slice(0, 40);
}

function reportTypeOf(text: string): ReportType {
  if (/literature\s+review/i.test(text)) return "literature-review";
  if (/gap\s+analysis|research\s+gaps?/i.test(text) && !/compare/i.test(text)) return "gap-analysis";
  if (/compar/i.test(text)) return /literature|review/i.test(text) ? "literature-review" : "comparison";
  if (/technical\s+summary/i.test(text)) return "technical-summary";
  return "research-report";
}
export function topicOf(text: string): string {
  const m = /\b(?:about|on|regarding|into|concerning)\s+(.+?)(?=\s*(?:[,;]|\s+(?:and\s+)?(?:then\s+)?(?:compare|identify|prepare|write|produce|create|generate|summari[sz]e|find|list|save|in\s+(?:my|the)\b)|$))/i.exec(text);
  let t = (m?.[1] ?? text)
    .replace(/^(?:the\s+)?(?:latest|recent|newest)\s+/i, "")
    .replace(/^(?:research\s+)?(?:papers?|documents?|work|literature)\s+(?:on|about)\s+/i, "")
    .replace(/[.?!]+$/, "").trim();
  if (!m) t = t.replace(/^(?:please\s+)?(?:write|prepare|produce|create|generate|do|make)\s+(?:a|an|the)?\s*/i, "").replace(RE.reportPhrase, "").replace(/^\s*(?:of|on|about|for)\s+/i, "").trim();
  // "graph neural networks from my research papers" -> "graph neural networks"
  return t.replace(new RegExp(`\\s+(?:in|from|using|across|and|plus|according\\s+to)\\s+${SRC}.*$`, "i"), "").trim().slice(0, 160);
}

/** `known`: names of existing collections (re-index requests are claimed only for these). */
export function parseKnowledgeRequest(objective: string, known: readonly string[] = []): KnowledgeIntent | null {
  const o = objective.trim();
  // Note and memory requests belong to their own grammars, whatever their quoted content says (a saved answer may mention "literature review").
  if (/^\s*(?:please\s+)?(?:create|make|write|add|take|save|start)\s+(?:me\s+)?(?:a\s+|an\s+|one\s+)?(?:new\s+)?(?:text\s+)?note\b/i.test(o) || /^\s*(?:please\s+)?remember\s+that\b/i.test(o)) return null;
  if (!o || o.length > 600) return null;
  let m: RegExpExecArray | null;
  if (RE.indexCode.test(o)) return { op: "index", folder: null, collection: "codebase", kind: "code" };
  if ((m = RE.indexPage.exec(o))) {
    const urls = urlsIn(m[1]!);
    if (urls.length) return { op: "index-page", urls, collection: (m[2] ?? "web").trim().toLowerCase().replace(/\s+/g, "-") };
  }
  if ((m = RE.index.exec(o))) { const folder = pathOf(m, 1); const collection = collectionNameOf(m[4], folder); return { op: "index", folder, collection, kind: kindForName(m[4] ?? collection) }; }
  if (RE.list.test(o)) return { op: "list" };
  if (RE.researchList.test(o)) return { op: "research-list" };
  if ((m = RE.researchShow.exec(o))) return { op: "research-show", name: m[1]!.trim() };
  if ((m = RE.researchResume.exec(o))) return { op: "research-resume", name: m[1]!.trim() };
  if ((m = RE.listDocs.exec(o))) return { op: "list-docs", collection: m[1]!.trim() };
  if ((m = RE.drop.exec(o))) return { op: "drop", collection: (m[1] ?? m[2])!.trim() };
  if ((m = RE.removePath.exec(o))) return { op: "remove-path", path: pathOf(m, 1) };
  // "refresh X" is claimed only for an existing collection (or "all"): "update the nightly workflow" is not ours.
  if ((m = RE.reindex.exec(o))) {
    const name = m[1]!.trim();
    if (/^(all|everything|knowledge(\s+base)?|all\s+collections)$/i.test(name)) return { op: "reindex", collection: "*" };
    const hit = known.find((k) => k.toLowerCase() === name.toLowerCase() || k.toLowerCase() === name.toLowerCase().replace(/\s+/g, "-"));
    if (hit) return { op: "reindex", collection: hit };
  }
  if (OTHER_ACTION.test(o.replace(/\band\s+(?:then\s+)?save\b/i, ""))) return null;

  // Research before ask: "prepare a literature review of X from my papers" is research, not a one-shot question.
  const latest = /\b(latest|most\s+recent|newest|recent)\b/i.test(o);
  if ((m = RE.researchVerb.exec(o)) || RE.reportPhrase.test(o)) {
    const sm = new RegExp(SRC, "i").exec(o);
    let scope: Scope = sm ? scopeOf(sm, 1) : { kind: "all" };
    if (scope.kind === "all" && /\b(?:research\s+(?:folder|papers|collection)|papers)\b/i.test(o)) scope = { kind: "type", type: "research" };
    // Optional online sources: web pages the user NAMES ("… using https://a and https://b"). Never searched for, never required.
    const urls = urlsIn(o);
    const noUrls = (t: string) => t.replace(/\s*(?:,\s*)?(?:(?:and\s+)?(?:using|from|with|including|plus)\s+)?(?:the\s+(?:web\s+)?pages?\s+)?https?:\/\/\S+(?:(?:\s*,\s*|\s+and\s+)https?:\/\/\S+)*/gi, "").trim();
    if (urls.length && !sm) scope = { kind: "named", name: "web" };
    const topic = topicOf(noUrls(m && !RE.reportPhrase.test(o) ? m[1]!.replace(new RegExp(`\\s+(?:in|from|using)\\s+${SRC}.*$`, "i"), "") : o));
    if (topic.length >= 3) return { op: "research", topic, question: noUrls(o), type: reportTypeOf(o), scope, latest, ...(urls.length ? { urls } : {}) };
  }
  if ((m = RE.searchA.exec(o))) return { op: "search", query: m[4]!.trim(), scope: scopeOf(m, 1) };
  if ((m = RE.searchB.exec(o)) && !/\.\w{2,4}\b|\b(?:files?|folders?)\s+(?:named|called)\b|^(?:all\s+|the\s+)?(?:files|folders|pdfs|images|photos)\b/i.test(m[1]!)) return { op: "search", query: m[1]!.trim(), scope: scopeOf(m, 2) };
  if ((m = RE.askA.exec(o)) || (m = RE.askC.exec(o))) return { op: "ask", question: m[4]!.trim(), scope: scopeOf(m, 1) };
  if ((m = RE.askB.exec(o)) && QUESTION_HEAD.test(m[1]!)) return { op: "ask", question: m[1]!.trim(), scope: scopeOf(m, 2) };
  if (RE.askCode.test(o)) return { op: "ask", question: o, scope: { kind: "type", type: "code" } };
  return null;
}

/** Web addresses the user wrote (http/https only; trailing punctuation dropped; at most 5). */
export function urlsIn(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s,;"'<>]+/gi) ?? []).map((u) => u.replace(/[.)\]!?]+$/, "")))].slice(0, 5);
}

// ── Service ─────────────────────────────────────────────────────────────────

/** The daemon cancels any task after 330 s (AgentHost:TaskTimeoutMs). Indexing stops itself well before that and reports
 *  "partial: refresh to continue" (finished documents are kept), instead of being cancelled from outside. */
export const INDEX_BUDGET_MS = 270_000;

export interface KnowledgeServiceOptions {
  store: KnowledgeStore;
  embedder: Embedder | null;
  model: LanguageModel | null;
  /** The workspace root (also the codebase collection's folder). */
  workspaceRoot: string;
  /** Extra folders that may be indexed (DASK_KNOWLEDGE_ROOTS + DASK_FS_ROOTS). */
  extraRoots: string[];
  researchDir?: string;
  log?: (m: string) => void;
  /** Wall-clock budget of one indexing run (default INDEX_BUDGET_MS); the next run continues incrementally. */
  indexBudgetMs?: number;
  /**
   * OPTIONAL online reading (the agent host's policy-locked local browser, the same engine as browser.read_page). Absent: web pages cannot be
   * indexed and research uses local documents only. Only pages the user names are read; nothing is searched for.
   */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<{ finalUrl: string; title: string; text: string; status: number; truncated: boolean }>;
}

export interface KnowledgeRunInput { taskId: string; objective: string; signal?: AbortSignal; emit?: (e: RuntimeEvent) => void }

interface StepRecord { id: string; tool: string; description: string; status: "succeeded" | "failed" | "cancelled"; evidence: string; error?: string; startedAt: number; finishedAt: number }

export class KnowledgeService {
  #roots: FileRoot[] | null = null;
  constructor(private readonly o: KnowledgeServiceOptions) {}

  claims(objective: string): boolean { return parseKnowledgeRequest(objective, this.#known()) !== null; }
  #known(): string[] { try { return this.o.store.collections().map((c) => c.name); } catch { return []; } }

  close(): void { this.o.store.close(); }

  async roots(): Promise<FileRoot[]> {
    if (!this.#roots) {
      const r = await resolveRoots(this.o.workspaceRoot, this.o.extraRoots);
      for (const x of r.rejected) this.o.log?.(`knowledge root refused: ${x.reason}`);
      this.#roots = r.roots;
    }
    return this.#roots;
  }

  status() { return { collections: this.o.store.collections().length, embedder: this.o.embedder?.status() ?? null, interruptedRunsRecovered: this.o.store.interruptedRuns }; }

  /** Runs a claimed request; null when the objective is not a knowledge request (the caller then uses the normal runtime). */
  async run(input: KnowledgeRunInput): Promise<RunReport | null> {
    const intent = parseKnowledgeRequest(input.objective, this.#known());
    if (!intent) return null;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(new Error("cancelled"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) ctl.abort();
    const run = new Run(input, ctl.signal);
    try {
      return await this.#dispatch(intent, run);
    } catch (e) {
      if (ctl.signal.aborted) return run.finish("cancelled", "Cancelled. Nothing further was indexed or generated; work already saved is kept.", null);
      this.o.log?.(`knowledge task failed: ${e instanceof Error ? e.stack : String(e)}`);
      return run.finish("failed", `The knowledge request failed: ${e instanceof Error ? e.message : String(e)}`, null, e instanceof Error ? e.message : String(e));
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  #collectionsFor(scope: Scope): { names: string[]; refusal: string | null } {
    const all = this.o.store.collections().filter((c) => c.documents > 0);
    if (all.length === 0) return { names: [], refusal: "Nothing is indexed yet. Index a folder first, for example: \"index D:\\Papers as research\" or \"index the codebase\"." };
    if (scope.kind === "named") {
      const c = this.o.store.collection(scope.name) ?? this.o.store.collection(scope.name.replace(/\s+/g, "-"));
      return c ? { names: [c.name], refusal: null } : { names: [], refusal: `There is no collection called "${scope.name}". Collections: ${all.map((x) => x.name).join(", ")}.` };
    }
    if (scope.kind === "type") {
      const t = all.filter((c) => c.kind === scope.type);
      if (t.length) return { names: t.map((c) => c.name), refusal: null };
      return { names: [], refusal: scope.type === "code" ? "The codebase is not indexed yet. Say \"index the codebase\" first." : `No ${scope.type} collection is indexed yet. Index one first, for example: "index D:\\Papers as research".` };
    }
    const nonCode = all.filter((c) => c.kind !== "code");
    return { names: (nonCode.length ? nonCode : all).map((c) => c.name), refusal: null };
  }

  async #dispatch(intent: KnowledgeIntent, run: Run): Promise<RunReport> {
    const store = this.o.store;
    switch (intent.op) {
      case "list": {
        const s = run.step("kb-list", "knowledge.list", "List knowledge collections");
        const cs = store.collections();
        const emb = this.o.embedder ? (this.o.embedder.status().state === "failed" ? `semantic search unavailable (${this.o.embedder.status().lastError})` : `semantic search: local ${this.o.embedder.modelId}`) : "semantic search: no embedding model (keyword search only)";
        const lines = cs.map((c) => { const last = store.lastRun(c.name); return `• ${c.name} [${c.kind}] — ${c.documents} document(s), ${c.chunks} passage(s), ${c.embedded === c.chunks ? "all" : `${c.embedded}/${c.chunks}`} with embeddings${c.unreadable ? `, ${c.unreadable} unreadable` : ""}; last indexed ${c.lastIndexedAt?.slice(0, 16).replace("T", " ") ?? "never"}${last && last.status !== "completed" ? ` (last run ${last.status})` : ""}\n  folders: ${c.roots.join("; ")}`; });
        s.ok(`${cs.length} collection(s)`);
        return run.finish("completed", cs.length ? `Knowledge collections (${emb}):\n${lines.join("\n")}` : `No knowledge collections yet (${emb}). Say "index <folder> as <name>" or "index the codebase".`, true);
      }
      case "list-docs": {
        const s = run.step("kb-list", "knowledge.list", `List documents in ${intent.collection}`);
        const c = store.collection(intent.collection);
        if (!c) { s.fail("no such collection"); return run.finish("refused", `There is no collection called "${intent.collection}".`, null); }
        const docs = store.documents(c.name);
        s.ok(`${docs.length} document(s)`);
        const shown = docs.slice(0, 40).map((d) => `• ${d.title}${d.title !== path.basename(d.path) ? ` — ${path.basename(d.path)}` : ""} [${d.status}${d.status === "unreadable" ? `: ${d.error}` : `, ${d.chunkCount} passages`}]`);
        return run.finish("completed", `${c.name}: ${docs.length} document(s)${docs.length > 40 ? " (first 40 shown)" : ""}\n${shown.join("\n")}`, true);
      }
      case "index": case "reindex": return this.#index(intent, run);
      case "index-page": {
        const got = await this.#ingestPages(intent.urls, intent.collection, run);
        if ("refuse" in got) return run.refuse(got.refuse);
        const ok = got.pages.filter((p) => p.ok);
        const text = [
          ok.length ? `Indexed ${ok.length} web page(s) into "${intent.collection}" (read now from the internet; cited by their address):` : "No page could be indexed.",
          ...got.pages.map((p) => p.ok ? `  • ${p.title} — ${p.url} (${p.chunks} passage(s))` : `  • ${p.url}: ${p.error}`),
          ...(ok.length ? ["Ask with \"according to my web collection, …\" or research with it."] : []),
        ].join("\n");
        const verified = ok.length > 0 && ok.every((p) => store.documents(intent.collection).some((d) => d.path === p.url && d.chunkCount > 0));
        return run.finish(ok.length === 0 ? "failed" : ok.length < got.pages.length ? "partial" : "completed", text, ok.length ? verified : null, undefined,
          ok.length ? { kind: "list", text, sources: ok.map((p) => ({ label: p.title, ref: p.url })), provenance: this.#prov("knowledge.index_page", run, true, verified) } : undefined);
      }
      case "drop": {
        const s = run.step("kb-remove", "knowledge.remove", `Remove collection ${intent.collection} from the index`);
        const c = store.collection(intent.collection);
        if (!c) { s.fail("no such collection"); return run.finish("refused", `There is no collection called "${intent.collection}". Collections: ${store.collections().map((x) => x.name).join(", ") || "none"}.`, null); }
        store.deleteCollection(c.name);
        const gone = store.collection(c.name) === null;
        s[gone ? "ok" : "fail"](gone ? `removed ${c.documents} document(s) from the index` : "still present");
        return run.finish(gone ? "completed" : "failed", gone ? `Removed the collection "${c.name}" (${c.documents} document(s), ${c.chunks} passages) from D-ASK's index. Your files were not touched.` : "The collection could not be removed.", gone);
      }
      case "remove-path": {
        const s = run.step("kb-remove", "knowledge.remove", "Remove a file or folder from the index");
        const target = path.resolve(intent.path);
        let removed = 0;
        for (const c of store.collections()) {
          for (const d of store.documents(c.name)) if (relativeInside(target, d.path) !== null) { store.deleteDocument(d.id); removed++; }
          if (c.roots.some((r) => relativeInside(target, r) !== null)) store.db.prepare("UPDATE collections SET roots=? WHERE name=?").run(JSON.stringify(c.roots.filter((r) => relativeInside(target, r) === null)), c.name);
        }
        if (!removed) { s.fail("nothing indexed there"); return run.finish("refused", `Nothing under ${target} is in the index.`, null); }
        s.ok(`removed ${removed} document(s)`);
        return run.finish("completed", `Removed ${removed} document(s) under ${target} from D-ASK's index (the files themselves were not touched). They will not come back unless you index that folder again.`, true);
      }
      case "search": {
        const sel = this.#collectionsFor(intent.scope);
        if (sel.refusal) return run.refuse(sel.refusal);
        const s = run.step("kb-retrieve", "knowledge.search", `Search ${sel.names.join(", ")} for "${intent.query}"`);
        const r = await retrieve(store, this.o.embedder, intent.query, sel.names, { k: 6 }, run.signal);
        s.ok(`${r.passages.length} passage(s), ${r.mode} retrieval`);
        if (!r.passages.length) return run.finish("completed", `No passage in ${sel.names.join(", ")} matches "${intent.query}".${r.note ? ` (${r.note})` : ""}`, false);
        const body = r.passages.map((p) => `[${p.n}] ${citation(p)}\n    "${p.chunk.text.replace(/\s+/g, " ").slice(0, 240)}${p.chunk.text.length > 240 ? "…" : ""}"`).join("\n");
        const kv = r.passages.some((p) => p.keyword);
        return run.finish("completed", `Found ${r.passages.length} passage(s) in ${sel.names.join(", ")} (${r.mode} search${r.note ? `; ${r.note}` : ""}):\n${body}`, kv, undefined,
          { kind: "passages", text: r.passages.map((p) => `[${p.n}] ${p.chunk.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n"), sources: r.passages.map(sourceOf), provenance: this.#prov("knowledge.search", run, r.passages.some(isWeb), kv) });
      }
      case "ask": {
        const sel = this.#collectionsFor(intent.scope);
        if (sel.refusal) return run.refuse(sel.refusal);
        const s1 = run.step("kb-retrieve", "knowledge.search", `Retrieve passages from ${sel.names.join(", ")}`);
        const r = await retrieve(store, this.o.embedder, intent.question, sel.names, { k: 5, perDocument: 2 }, run.signal);
        s1.ok(`${r.passages.length} passage(s), ${r.mode} retrieval`);
        const s2 = run.step("kb-answer", "knowledge.answer", "Answer from the retrieved passages only");
        const g = await generateGrounded(this.o.model, intent.question, r.passages, run.signal);
        s2[g.status === "insufficient" ? "fail" : "ok"](`${g.status}; ${g.cited.length} source(s) cited${g.unsupportedSentences ? `; ${g.unsupportedSentences} sentence(s) marked as inference` : ""}`);
        const cited = r.passages.filter((p) => g.cited.includes(p.n));
        // The artifact carries only what the passages support: an insufficient answer passes on nothing but the statement that it is insufficient.
        const atext = g.status === "insufficient" ? groundedText(g, r.passages, sel.names, r.note) : g.text;
        return run.finish("answered", groundedText(g, r.passages, sel.names, r.note), null, undefined,
          { kind: "answer", text: atext, sources: cited.map(sourceOf), provenance: { ...this.#prov("knowledge.answer", run, cited.some(isWeb), null), grounding: g.status, question: intent.question } });
      }
      case "research": return this.#research(intent, run);
      case "research-list": {
        const s = run.step("kb-research-list", "research.list", "List research projects");
        const ps = listProjects(this.o.researchDir);
        s.ok(`${ps.length} project(s)`);
        return run.finish("completed", ps.length ? `Research projects:\n${ps.map((p) => `• ${p.topic} — ${REPORT_TITLES[p.type]}, ${p.versions.length} version(s), last ${p.versions.at(-1)?.createdAt.slice(0, 16).replace("T", " ")}, ${p.versions.at(-1)?.sources ?? 0} source(s) [id ${p.id}]`).join("\n")}` : "No research projects yet. Say, for example: \"prepare a literature review on graph neural networks from my research papers\".", true);
      }
      case "research-show": {
        const s = run.step("kb-research-list", "research.show", `Show research project ${intent.name}`);
        const p = findProject(intent.name, this.o.researchDir);
        if (!p) { s.fail("not found"); return run.finish("refused", `No research project matches "${intent.name}". Say "list research projects".`, null); }
        const v = p.versions.at(-1)!;
        const file = path.join(this.o.researchDir ?? defaultResearchDir(), p.id, v.report);
        s.ok("found");
        return run.finish("completed", `${REPORT_TITLES[p.type]}: ${p.topic}\nQuestion: ${p.question}\nVersions: ${p.versions.length}; latest ${v.createdAt.slice(0, 16).replace("T", " ")} with ${v.sources} source(s)\nReport: ${file}`, true);
      }
      case "research-resume": {
        const p = findProject(intent.name, this.o.researchDir);
        if (!p) return run.refuse(`No research project matches "${intent.name}". Say "list research projects".`);
        return this.#research({ op: "research", topic: p.topic, question: p.question, type: p.type, scope: { kind: "all" }, latest: p.latest }, run, p.id, p.collections);
      }
    }
  }

  async #index(intent: Extract<KnowledgeIntent, { op: "index" | "reindex" }>, run: Run): Promise<RunReport> {
    const store = this.o.store;
    const roots = await this.roots();
    let targets: { name: string; kind: CollectionKind; folders: string[] }[] = [];
    if (intent.op === "index") {
      const folderIn = intent.folder ?? this.o.workspaceRoot;
      const res = await resolveIndexFolder(roots, folderIn);
      if (!res.ok) return run.refuse(`I can't index ${folderIn}: ${res.reason}.`);
      const existing = store.collection(intent.collection);
      const c = store.upsertCollection(existing?.name ?? intent.collection, existing?.kind ?? intent.kind, [res.folder]);
      targets = [{ name: c.name, kind: c.kind, folders: [res.folder] }];
    } else {
      const cs = intent.collection === "*" ? store.collections() : [store.collection(intent.collection)].filter((x): x is Collection => x !== null);
      if (!cs.length) return run.refuse(intent.collection === "*" ? "Nothing is indexed yet." : `There is no collection called "${intent.collection}".`);
      targets = cs.map((c) => ({ name: c.name, kind: c.kind, folders: c.roots }));
    }
    const reports: IndexReport[] = [];
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.o.indexBudgetMs ?? INDEX_BUDGET_MS);
    const signal = AbortSignal.any([run.signal, budget.signal]);
    try {
      for (const t of targets) {
        if (t.kind === "web") {
          // A web collection has no folders: refreshing it re-reads each page by its address (optional online feature).
          const urls = store.documents(t.name).map((d) => d.path);
          const got = urls.length ? await this.#ingestPages(urls, t.name, run) : { pages: [] };
          const pages = "pages" in got ? got.pages : [];
          const bad = pages.filter((x) => !x.ok);
          reports.push({ collection: t.name, seen: pages.length, indexed: pages.length - bad.length, unchanged: 0, failed: bad.length, removed: 0, keywordOnly: 0, status: "refuse" in got ? "failed" : "completed",
            stoppedAtLimit: false, failures: "refuse" in got ? [{ path: t.name, reason: got.refuse }] : bad.map((x) => ({ path: x.url, reason: x.error ?? "not read" })), embeddingNote: null });
          continue;
        }
        // A folder that no longer resolves inside the allowed roots is skipped, never read.
        const ok: string[] = [];
        for (const f of t.folders) { const r = await resolveIndexFolder(roots, f); if (r.ok) ok.push(r.folder); }
        const s = run.step(`kb-index-${reports.length + 1}`, "knowledge.index", `Index ${ok.join("; ") || "(no readable folder)"} into "${t.name}"`);
        if (!ok.length) { s.fail("no folder of this collection is readable"); continue; }
        const r = await indexCollection({ store, embedder: this.o.embedder, log: this.o.log }, t.name, t.kind, ok, signal);
        reports.push(r);
        if (run.signal.aborted) { s.cancel(); break; }
        s[r.status === "failed" ? "fail" : "ok"](`${r.indexed} indexed, ${r.unchanged} unchanged, ${r.removed} removed, ${r.failed} unreadable${r.keywordOnly ? `, ${r.keywordOnly} keyword-only` : ""}`);
      }
    } finally { clearTimeout(timer); }
    if (run.signal.aborted) return run.finish("cancelled", `Indexing was cancelled. ${summarize(reports)} Documents finished before the stop are kept; the rest will be indexed next time.`, null);
    const timedOut = budget.signal.aborted;
    // Independent check: every document this run reported as indexed is in the store with its passages.
    const verified = reports.length > 0 && reports.every((r) => { const c = store.collection(r.collection); return !!c && c.documents >= r.indexed && (r.indexed === 0 || c.chunks > 0); });
    const failures = reports.flatMap((r) => r.failures).slice(0, 5).map((f) => `  - ${path.basename(f.path) || "run"}: ${f.reason}`);
    const notes = [...new Set(reports.map((r) => r.embeddingNote).filter(Boolean))];
    const text = [
      `${timedOut ? "Indexing stopped at its time budget" : "Indexing finished"}. ${summarize(reports)}`,
      ...(failures.length ? ["Unreadable files:", ...failures] : []),
      ...notes.map((n) => `Note: ${n}.`),
      ...(reports.some((r) => r.stoppedAtLimit) ? ["The per-run file limit was reached; say \"refresh <collection>\" to continue."] : []),
      ...(timedOut ? ["Say \"refresh <collection>\" to continue; finished documents are kept."] : []),
      "Ask with, for example: \"according to my documents, …\" or \"search my documents for …\".",
    ].join("\n");
    const anyFailed = reports.some((r) => r.status === "failed") || reports.length < targets.length;
    return run.finish(anyFailed || timedOut ? "partial" : "completed", text, verified && !anyFailed && !timedOut);
  }

  #prov(tool: string, run: Run, online: boolean, verified: boolean | null) {
    return { tool, objective: run.objective, outcome: "completed" as RunOutcome, verified, online, at: new Date().toISOString() };
  }

  /** Reads web pages the user NAMED (optional online feature) and indexes each as one document whose path is its URL. */
  async #ingestPages(urls: string[], collection: string, run: Run): Promise<{ refuse: string } | { pages: { url: string; ok: boolean; title: string; chunks: number; error?: string }[] }> {
    if (!this.o.fetchPage) return { refuse: "Reading web pages is not enabled in this installation (AgentHost:BrowserRead). Everything else in D-ASK works offline; research can use your local documents." };
    const store = this.o.store;
    const existing = store.collection(collection);
    if (existing && existing.kind !== "web") return { refuse: `"${collection}" is a ${existing.kind} collection of local folders; web pages go into a web collection (for example "web").` };
    store.upsertCollection(existing?.name ?? collection, "web", []);
    if (this.o.embedder) store.bindEmbeddingModel(this.o.embedder.modelId);
    const pages: { url: string; ok: boolean; title: string; chunks: number; error?: string }[] = [];
    for (const url of urls) {
      if (run.signal.aborted) throw new Error("Cancelled");
      const s = run.step(`kb-web-${pages.length + 1}`, "knowledge.index_page", `Read and index ${url}`);
      try {
        const r = await this.o.fetchPage(url, run.signal);
        if (r.status < 200 || r.status >= 300) throw new Error(`the page answered with HTTP ${r.status}`);
        const doc = parseWebPage(r.title || r.finalUrl, r.text);
        const id = docIdOf(collection, r.finalUrl);
        const chunks = chunkDocument(id, doc);
        let vectors: (Float32Array | null)[] | null = null;
        if (this.o.embedder) {
          try { vectors = await this.o.embedder.embed(chunks.map((c) => `${doc.title}${c.heading ? " — " + c.heading : ""}\n${c.text}`), "document", run.signal); }
          catch (e) { if (run.signal.aborted) throw e; vectors = null; }
        }
        store.replaceDocument({ id, collection, path: r.finalUrl, title: doc.title.slice(0, 300), format: "html", size: r.text.length, mtimeMs: Date.now(),
          sha256: createHash("sha256").update(r.text).digest("hex"), pages: null, status: vectors ? "indexed" : "keyword-only", error: null }, chunks, vectors);
        s.ok(`${chunks.length} passage(s)${r.truncated ? " (page text was cut at the reader's limit)" : ""}`);
        pages.push({ url: r.finalUrl, ok: true, title: doc.title, chunks: chunks.length });
      } catch (e) {
        if (run.signal.aborted) throw e;
        const msg = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : String(e);
        s.fail(msg);
        pages.push({ url, ok: false, title: url, chunks: 0, error: `not indexed (${msg}; are you online?)` });
      }
    }
    store.touchCollection(existing?.name ?? collection);
    return { pages };
  }

  async #research(intent: Extract<KnowledgeIntent, { op: "research" }>, run: Run, projectId?: string, fixedCollections?: string[]): Promise<RunReport> {
    // Optional online sources first: the pages the user named are read and indexed into "web", then researched with the chosen local collections.
    let webNote: string | null = null;
    let named: string[] = [];
    if (intent.urls?.length) {
      const got = await this.#ingestPages(intent.urls, "web", run);
      if ("refuse" in got) return run.refuse(got.refuse);
      named = got.pages.filter((p) => p.ok).map((p) => p.url);
      const bad = got.pages.filter((p) => !p.ok);
      webNote = `Online sources: ${got.pages.length - bad.length} of ${got.pages.length} named page(s) read now${bad.length ? `; not read: ${bad.map((b) => b.url).join(", ")}` : ""}.`;
      if (bad.length === got.pages.length && intent.scope.kind === "named" && intent.scope.name === "web" && !this.o.store.documents("web").length) return run.finish("failed", `None of the named pages could be read, so there is nothing to research. ${webNote}`, null);
    }
    let names = fixedCollections?.filter((n) => this.o.store.collection(n)) ?? [];
    if (!names.length) {
      const sel = this.#collectionsFor(intent.scope);
      if (sel.refusal) return run.refuse(sel.refusal);
      names = sel.names;
    }
    if (intent.urls?.length && this.o.store.collection("web") && !names.includes("web")) names.push("web");
    const s1 = run.step("kb-research-plan", "research.plan", `Plan: ${REPORT_TITLES[intent.type].toLowerCase()} on "${intent.topic}" from ${names.join(", ")}`);
    s1.ok("aspects planned");
    const s2 = run.step("kb-research-run", "research.run", "Retrieve sources, extract evidence and synthesise");
    const res = await runResearch({ store: this.o.store, embedder: this.o.embedder, model: this.o.model, dir: this.o.researchDir, onStage: (st) => this.o.log?.(`research: ${st}`) },
      { topic: intent.topic, question: intent.question, type: intent.type, collections: names, latest: intent.latest, projectId, mustInclude: named }, run.signal);
    s2[res.sources.length ? "ok" : "fail"](`${res.sources.length} source(s); evidence for ${res.aspectsWithEvidence}/${res.aspectsTotal} aspects; ${res.modelSections} synthesised section(s)`);
    const s3 = run.step("kb-research-save", "research.save", "Save and re-read the report");
    let saved = false;
    try { const buf = await fsp.readFile(res.reportPath); saved = createHash("sha256").update(buf).digest("hex") === res.sha256; } catch { saved = false; }
    s3[saved ? "ok" : "fail"](saved ? `saved ${res.reportPath}` : "the report could not be read back");
    const v = res.project.versions.length;
    const text = [
      res.sources.length
        ? `${REPORT_TITLES[intent.type]} on "${intent.topic}"${v > 1 ? ` (version ${v})` : ""}: ${res.sources.length} source(s) from ${names.join(", ")}; evidence found for ${res.aspectsWithEvidence} of ${res.aspectsTotal} aspects.`
        : `No indexed document in ${names.join(", ")} matched "${intent.topic}". The saved report says so; nothing was invented.`,
      ...res.sources.map((d, i) => `  [D${i + 1}] ${d.title.slice(0, 90)}`),
      `Report: ${res.reportPath}`,
      res.sources.some((d) => /^https?:\/\//i.test(d.path))
        ? "Includes web pages you named (read now, cited by their address) and your locally indexed documents. Extracts are verbatim; the synthesis was written by the local model and its citations were checked."
        : "Based only on your locally indexed documents (no online sources). Extracts are verbatim; the synthesis was written by the local model and its citations were checked.",
      ...(webNote ? [webNote] : []),
      ...res.notes.map((n) => `Note: ${n}`),
    ].join("\n");
    return run.finish(saved ? (res.sources.length ? "completed" : "partial") : "failed", text, saved && res.sources.length > 0 ? false : null, undefined,
      saved ? { kind: "report", text, sources: res.sources.map((d) => ({ label: d.title, ref: d.path })), file: res.reportPath,
        provenance: this.#prov("research.run", run, res.sources.some((d) => /^https?:\/\//i.test(d.path)), null) } : undefined);
  }
}

function summarize(rs: IndexReport[]): string {
  if (!rs.length) return "Nothing was indexed.";
  return rs.map((r) => `"${r.collection}": ${r.seen} file(s) seen, ${r.indexed} indexed, ${r.unchanged} unchanged, ${r.removed} removed, ${r.failed} unreadable.`).join(" ");
}

function groundedText(g: GroundedAnswer, passages: Passage[], collections: string[], note: string | null): string {
  const cited = passages.filter((p) => g.cited.includes(p.n));
  const head = g.status === "insufficient"
    ? `I couldn't find enough in ${collections.join(", ")} to answer that${g.note ? ` (${g.note})` : ""}.`
    : g.status === "extractive" ? `Most relevant passages (${g.note}):\n${g.text}` : g.text;
  const sources = (cited.length ? cited : g.status === "insufficient" ? passages.slice(0, 3) : []).map((p) => `[${p.n}] ${citation(p)}`);
  return [head, ...(sources.length ? [g.status === "insufficient" ? "Closest passages:" : "Sources:", ...sources] : []), ...(note ? [`Note: ${note}.`] : [])].join("\n");
}

// ── One run: steps, events and the final RunReport ──────────────────────────

class Run {
  readonly steps: StepRecord[] = [];
  readonly signal: AbortSignal;
  private planned = false;
  constructor(private readonly input: KnowledgeRunInput, signal: AbortSignal) { this.signal = signal; }
  private emit(e: RuntimeEvent) { try { this.input.emit?.(e); } catch { /* progress never affects a task */ } }

  step(id: string, tool: string, description: string) {
    if (!this.planned) { this.planned = true; this.emit({ type: "phase", phase: "executing" }); }
    this.emit({ type: "plan", iteration: 1, plan: this.plan([...this.steps.map((s) => ({ id: s.id, tool: s.tool, description: s.description })), { id, tool, description }]) });
    this.emit({ type: "step.started", stepId: id, tool, description, input: {} });
    const rec: StepRecord = { id, tool, description, status: "succeeded", evidence: "", startedAt: Date.now(), finishedAt: 0 };
    this.steps.push(rec);
    const done = (status: StepRecord["status"], evidence: string) => {
      rec.status = status; rec.evidence = evidence; rec.finishedAt = Date.now();
      if (status === "failed") rec.error = evidence;
      this.emit({ type: "step.finished", stepId: id, tool, status, evidence, durationMs: rec.finishedAt - rec.startedAt });
    };
    return { ok: (e: string) => done("succeeded", e), fail: (e: string) => done("failed", e), cancel: () => done("cancelled", "cancelled") };
  }

  private plan(steps: { id: string; tool: string; description: string }[]): Plan {
    return { intent: "task", goal: this.input.objective.slice(0, 200), successCriteria: [], steps: steps.map((s) => ({ id: s.id, description: s.description, tool: s.tool, input: {}, dependsOn: [] })) };
  }

  refuse(text: string): RunReport {
    this.emit({ type: "plan", iteration: 1, plan: { intent: "unsupported", goal: text.slice(0, 200), refusalReason: text, clarification: text, successCriteria: [], steps: [] } });
    return this.finish("refused", text, null);
  }

  /** verified: true/false = a deterministic check was made (and its result); null = no verification applies. */
  get objective(): string { return this.input.objective; }

  finish(outcome: RunOutcome, response: string, verified: boolean | null, error?: string, artifact?: Artifact): RunReport {
    if (artifact) artifact = { ...artifact, provenance: { ...artifact.provenance, outcome } };
    for (const s of this.steps) if (!s.finishedAt) { s.status = "cancelled"; s.finishedAt = Date.now(); }
    const steps: StepState[] = this.steps.map((s) => ({
      step: { id: s.id, description: s.description, tool: s.tool, input: {}, dependsOn: [] }, status: s.status, attempt: 1, startedAt: s.startedAt, finishedAt: s.finishedAt,
      outcome: { ok: s.status === "succeeded", evidence: s.evidence }, ...(s.error ? { error: s.error } : {}),
    }));
    const ok = this.steps.filter((s) => s.status === "succeeded").length;
    const verification: VerificationReport | null = verified === null ? null : {
      stepsSucceeded: ok, stepsTotal: this.steps.length, criteriaSatisfied: verified, needsMoreSteps: false, missing: [], method: "evidence-only",
      notes: ["checked deterministically against the local knowledge index / saved file"],
      grounding: this.steps.map((s) => ({ stepId: s.id, tool: s.tool, status: "grounded" as const, reason: "the operation the request states" })),
      facets: [{ id: "knowledge:request", description: this.input.objective.slice(0, 120), satisfied: verified }], unexplained: [], independentlyVerified: verified,
    };
    if (verification) this.emit({ type: "verification", report: verification });
    const report: RunReport = { taskId: this.input.taskId, outcome, plan: this.steps.length ? this.plan(this.steps) : null, steps, verification, response, iterations: 1, toolCalls: this.steps.length, ...(error ? { error } : {}), ...(artifact ? { artifact } : {}) };
    this.emit({ type: "finished", report });
    return report;
  }
}

const isWeb = (p: Passage) => /^https?:\/\//i.test(p.doc.path);
function sourceOf(p: Passage): ArtifactSource { return { label: p.doc.title, ref: p.doc.path, page: p.chunk.page }; }
