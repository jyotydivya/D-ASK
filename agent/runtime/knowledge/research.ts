// ─────────────────────────────────────────────────────────────────────────────
// Research Mode: structured, citation-preserving research over the SAME knowledge index (no second retrieval engine).
//   1. Plan: the topic is decomposed into research aspects that depend on the report type (deterministic, so the plan is
//      inspectable and repeatable on a 0.5B model).
//   2. Sources: documents are ranked by hybrid retrieval on the topic (reference lists excluded); "latest" prefers recent years.
//   3. Evidence: for every source and aspect, the best-matching sentences are EXTRACTED verbatim with page/section references
//      (deterministic; the evidence table is never written by the model).
//   4. Synthesis: per aspect, the local model writes a short synthesis from those extracts only; citations are validated
//      (ground.ts). Aspects with no evidence are reported as gaps in coverage, not filled in.
//   5. Output: a Markdown report + project.json + evidence.json under Documents\D-ASK\Research\<project>; re-running ("resume")
//      adds a new version and keeps earlier ones. Local-only research says so in the report.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "../types";
import type { Embedder } from "./embedder";
import { generateGrounded } from "./ground";
import { citation, contentTerms, REFERENCE_SECTIONS, retrieve, type Passage } from "./retrieve";
import type { DocumentRow, KnowledgeStore } from "./store";

export type ReportType = "literature-review" | "comparison" | "gap-analysis" | "technical-summary" | "research-report";

interface Aspect { id: string; title: string; query: string; cues: RegExp }
const ASPECTS: Record<string, Omit<Aspect, "query"> & { q: string }> = {
  overview: { id: "overview", title: "Problem and motivation", q: "problem motivation challenge overview", cues: /\b(problem|challenge|motivat|aim|goal|we (?:study|address|consider|investigate)|this (?:paper|work|study))\b/i },
  method: { id: "method", title: "Methodologies", q: "proposed method approach architecture model algorithm", cues: /\b(we propose|propose|our (?:method|approach|model|framework)|architecture|algorithm|we (?:use|adopt|introduce|design)|based on|layer|aggregat|attention|framework)\b/i },
  data: { id: "data", title: "Datasets and evaluation", q: "dataset benchmark evaluation metric experimental setup", cues: /\b(dataset|benchmark|evaluat|metric|accuracy|f1|baseline|experiment|split|corpus)\b/i },
  findings: { id: "findings", title: "Findings and results", q: "results findings performance outperforms improvement", cues: /\b(result|outperform|improv|achiev|show(?:s|ed)? that|we find|demonstrat|significant|state[- ]of[- ]the[- ]art|%)\b/i },
  limits: { id: "limits", title: "Limitations and research gaps", q: "limitations future work open problems challenges remain", cues: /\b(limitation|future work|remain|open (?:problem|question|challenge)|not (?:address|consider|scale)|fail|drawback|however|lack|leave .* (?:to|for) future|scalab)\b/i },
};
const PLAN: Record<ReportType, string[]> = {
  "literature-review": ["overview", "method", "data", "findings", "limits"],
  "comparison": ["method", "data", "findings", "limits"],
  "gap-analysis": ["overview", "limits", "findings"],
  "technical-summary": ["overview", "method", "findings"],
  "research-report": ["overview", "method", "findings", "limits"],
};
export const REPORT_TITLES: Record<ReportType, string> = {
  "literature-review": "Literature review", "comparison": "Methodology comparison", "gap-analysis": "Research gap analysis",
  "technical-summary": "Technical summary", "research-report": "Research report",
};

export interface ResearchRequest { topic: string; question: string; type: ReportType; collections: string[]; latest: boolean; projectId?: string;
  /** Document paths the user NAMED for this research (web pages read for it): always among the sources, even when their text duplicates another document. */
  mustInclude?: string[] }
export interface ResearchProject { id: string; topic: string; question: string; type: ReportType; collections: string[]; latest: boolean; createdAt: string; versions: { version: number; createdAt: string; report: string; sha256: string; sources: number; modelSections: number }[] }
export interface ResearchResult { project: ResearchProject; reportPath: string; sha256: string; sources: DocumentRow[]; aspectsWithEvidence: number; aspectsTotal: number; modelSections: number; notes: string[] }

export function defaultResearchDir(): string {
  const o = process.env.DASK_RESEARCH_DIR;
  if (o && path.isAbsolute(o)) return o;
  return path.join(process.env.USERPROFILE || os.homedir(), "Documents", "D-ASK", "Research");
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "research";

export function listProjects(dir = defaultResearchDir()): ResearchProject[] {
  if (!fs.existsSync(dir)) return [];
  const out: ResearchProject[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    // project.json is a user-writable file: its id must be the folder it is in (slug characters only), so a crafted id can never point a
    // resumed run's report outside the research folder.
    try { const p = JSON.parse(fs.readFileSync(path.join(dir, d.name, "project.json"), "utf8")) as ResearchProject; if (typeof p.id === "string" && /^[a-z0-9-]{1,80}$/.test(p.id) && p.id === d.name && Array.isArray(p.versions)) out.push(p); } catch { /* not a project */ }
  }
  return out.sort((a, b) => (b.versions.at(-1)?.createdAt ?? b.createdAt).localeCompare(a.versions.at(-1)?.createdAt ?? a.createdAt));
}

export function findProject(name: string, dir = defaultResearchDir()): ResearchProject | null {
  const all = listProjects(dir);
  const n = name.toLowerCase().trim();
  return all.find((p) => p.id === n) ?? all.find((p) => p.topic.toLowerCase() === n) ?? all.find((p) => p.topic.toLowerCase().includes(n) || p.id.includes(slug(n))) ?? null;
}

function yearOf(doc: DocumentRow, firstText: string): number | null {
  const ys = [...`${doc.title} ${path.basename(doc.path)} ${firstText.slice(0, 1500)}`.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)].map((m) => Number(m[1])).filter((y) => y <= new Date().getFullYear() + 1);
  return ys.length ? Math.max(...ys) : null;
}

function bestSentences(passages: Passage[], cues: RegExp, topicTerms: Set<string>, max: number): { text: string; ref: Passage }[] {
  const cands: { text: string; ref: Passage; score: number }[] = [];
  for (const p of passages) {
    for (const s of p.chunk.text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      if (s.length < 40 || s.length > 600) continue;
      const cue = cues.test(s) ? 2 : 0;
      const topic = contentTerms(s).filter((t) => topicTerms.has(t)).length;
      if (cue === 0) continue; // the sentence must speak to this aspect, not merely mention the topic
      cands.push({ text: s.trim(), ref: p, score: cue + Math.min(topic, 3) + (p.cosine ?? 0) });
    }
  }
  const seen = new Set<string>();
  return cands.sort((a, b) => b.score - a.score).filter((c) => { const k = c.text.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
}

export interface ResearchDeps { store: KnowledgeStore; embedder: Embedder | null; model: LanguageModel | null; dir?: string; onStage?: (stage: string) => void; synthesisBudgetMs?: number }

export async function runResearch(deps: ResearchDeps, req: ResearchRequest, signal: AbortSignal): Promise<ResearchResult> {
  const dir = deps.dir ?? defaultResearchDir();
  const notes: string[] = [];
  const stage = (s: string) => { try { deps.onStage?.(s); } catch { /* ignore */ } };
  const topicTerms = new Set(contentTerms(req.topic));

  // 2. Sources.
  stage("selecting sources");
  const topical = await retrieve(deps.store, deps.embedder, req.question, req.collections, { k: 40, perDocument: 4, candidates: 80, excludeSections: REFERENCE_SECTIONS, minCosine: 0.62 }, signal);
  if (topical.note) notes.push(topical.note);
  const docScore = new Map<string, { doc: DocumentRow; score: number; passages: Passage[] }>();
  for (const p of topical.passages) {
    const e = docScore.get(p.doc.id) ?? { doc: p.doc, score: 0, passages: [] };
    e.score += p.score; e.passages.push(p); docScore.set(p.doc.id, e);
  }
  let ranked = [...docScore.values()].sort((a, b) => b.score - a.score);
  if (req.latest) {
    const withYear = ranked.map((r) => ({ ...r, year: yearOf(r.doc, r.passages[0]?.chunk.text ?? "") }));
    withYear.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.score - a.score);
    ranked = withYear;
    notes.push(`"Latest" was interpreted from years found in each document's title or first page${withYear.some((w) => w.year === null) ? " (documents without a year are ranked last)" : ""}.`);
  }
  // Documents the user named for this research come first (found in the real HUD: two identical pages, and retrieval's duplicate filter kept the one
  // the user had NOT named). Their passages are taken directly from the store when retrieval returned none of them.
  for (const pth of [...(req.mustInclude ?? [])].reverse()) {
    const at = ranked.findIndex((r) => r.doc.path === pth);
    if (at >= 0) { ranked.unshift(ranked.splice(at, 1)[0]!); continue; }
    const doc = req.collections.flatMap((c) => deps.store.documents(c)).find((d) => d.path === pth && d.status !== "unreadable");
    if (!doc) continue;
    const rows = deps.store.db.prepare("SELECT rowid FROM chunks WHERE doc_id=? ORDER BY ordinal LIMIT 4").all(doc.id) as { rowid: number }[];
    const passages = deps.store.chunksByRowid(rows.map((r) => r.rowid)).map((chunk, i) => ({ n: i + 1, chunk, doc, score: 0, cosine: null, keyword: false }));
    ranked.unshift({ doc, score: 0, passages, ...({} as { year?: number | null }) } as (typeof ranked)[number]);
  }
  const sources = ranked.slice(0, 6);
  const label = new Map(sources.map((s, i) => [s.doc.id, `D${i + 1}`]));

  // 3. Evidence per aspect (verbatim extracts) and 4. synthesis.
  const aspects: Aspect[] = PLAN[req.type].map((id) => ({ ...ASPECTS[id]!, query: `${req.topic} ${ASPECTS[id]!.q}` }));
  const sections: { aspect: Aspect; extracts: { doc: string; text: string; cite: string }[]; synthesis: string | null; synthesisNote: string | null }[] = [];
  let modelSections = 0;
  // The daemon cancels a task at 330 s: after this budget the remaining aspects get evidence only (said in the report), never a cancelled run.
  const synthesisDeadline = Date.now() + (deps.synthesisBudgetMs ?? 200_000);
  for (const aspect of aspects) {
    if (signal.aborted) throw new Error("Cancelled");
    stage(`researching: ${aspect.title.toLowerCase()}`);
    const r = sources.length ? await retrieve(deps.store, deps.embedder, aspect.query, req.collections, { k: 18, perDocument: 3, candidates: 60, excludeSections: REFERENCE_SECTIONS, minCosine: 0.58 }, signal) : { passages: [] as Passage[] };
    const fromSources = r.passages.filter((p) => label.has(p.doc.id));
    const extracts: { doc: string; text: string; cite: string }[] = [];
    for (const s of sources) {
      const mine = fromSources.filter((p) => p.doc.id === s.doc.id).concat(s.passages);
      for (const b of bestSentences(mine, aspect.cues, topicTerms, 2)) extracts.push({ doc: label.get(s.doc.id)!, text: b.text, cite: citation(b.ref) });
    }
    let synthesis: string | null = null; let synthesisNote: string | null = null;
    if (extracts.length >= 1 && deps.model && Date.now() >= synthesisDeadline) synthesisNote = "Not synthesised: the time budget for this run was used up; read the evidence below.";
    else if (extracts.length >= 1 && deps.model) {
      // The model sees only the extracts, renumbered as passages, and must cite them.
      const pseudo: Passage[] = extracts.slice(0, 8).map((x, i) => ({ n: i + 1, score: 0, cosine: null, keyword: false, doc: sources.find((s) => label.get(s.doc.id) === x.doc)!.doc, chunk: { rowid: -1, id: `x${i}`, docId: "", collection: "", ordinal: 0, heading: "", page: null, pageEnd: null, lineStart: null, lineEnd: null, symbol: null, text: x.text } }));
      const q = req.type === "comparison" || aspect.id === "method"
        ? `Compare the ${aspect.title.toLowerCase()} across these sources on "${req.topic}": similarities, differences and any disagreement.`
        : `Summarise the ${aspect.title.toLowerCase()} reported in these sources on "${req.topic}".`;
      try {
        const g = await generateGrounded(deps.model, q, pseudo, signal, 75_000);
        if (g.status === "grounded" || g.status === "partially-grounded") {
          // [n] -> [Dk] so the report's citations point at the source list.
          synthesis = g.text.replace(/\[(\d{1,2})\]/g, (_m, d: string) => `[${extracts[Number(d) - 1]?.doc ?? "?"}]`);
          modelSections++;
          if (g.status === "partially-grounded") synthesisNote = "Some sentences are the model's inference and are marked as such.";
        } else synthesisNote = "The local model's summary could not be tied to these extracts, so it was left out; read the evidence below.";
      } catch (e) {
        if (signal.aborted) throw e;
        synthesisNote = `No synthesis: ${e instanceof Error ? e.message.slice(0, 100) : e}`;
      }
    } else if (!deps.model) synthesisNote = "The local model is not available; only verbatim extracts are shown.";
    sections.push({ aspect, extracts, synthesis, synthesisNote });
  }

  // 5. Report.
  stage("writing the report");
  const now = new Date();
  const stamp = now.toISOString();
  const existing = req.projectId ? findProject(req.projectId, dir) : null;
  const id = existing?.id ?? `${slug(req.topic)}-${stamp.slice(0, 10).replace(/-/g, "")}${createHash("sha256").update(req.question + stamp).digest("hex").slice(0, 4)}`;
  const version = (existing?.versions.length ?? 0) + 1;
  const projDir = path.join(dir, id);
  fs.mkdirSync(projDir, { recursive: true });
  const covered = sections.filter((s) => s.extracts.length > 0).length;
  const lines: string[] = [];
  lines.push(`# ${REPORT_TITLES[req.type]}: ${req.topic}`, "");
  lines.push(`*Question:* ${req.question}  `, `*Generated:* ${stamp} by D-ASK (local model, offline)  `, `*Collections searched:* ${req.collections.join(", ")}  `, `*Version:* ${version}`, "");
  const web = sources.filter((s) => /^https?:\/\//i.test(s.doc.path));
  lines.push("> **Scope.** " + (web.length
    ? `This report uses documents indexed locally in the collections above, including ${web.length} web page(s) the user named, read from the internet and cited by their address (read: ${web.map((w) => new Date(w.doc.mtimeMs).toISOString().slice(0, 16).replace("T", " ") + " UTC").join(", ")}). No web search was performed. `
    : "This report is based only on documents indexed locally in the collections above. No online sources were consulted. ") +
    "Evidence extracts are quoted verbatim from the documents; the synthesis paragraphs were written by a small local model from those extracts only, and every citation in them was checked against the extracts it names. Statements marked \"model inference\" are not supported by a cited extract.", "");
  if (!sources.length) {
    lines.push("## Result", "", "No indexed document in these collections matched the topic. Nothing below is based on evidence.", "");
  } else {
    lines.push("## Research plan", "", ...sections.map((s, i) => `${i + 1}. ${s.aspect.title}${s.extracts.length ? "" : " — **no evidence found**"}`), "");
    lines.push("## Sources", "", ...sources.map((s) => `- **[${label.get(s.doc.id)}]** ${s.doc.title}${s.doc.pages ? ` (${s.doc.pages} pages)` : ""} — \`${s.doc.path}\``), "");
    for (const s of sections) {
      lines.push(`## ${s.aspect.title}`, "");
      if (!s.extracts.length) { lines.push("*No passage in the selected sources addresses this aspect. This is a gap in the indexed evidence, not a finding about the field.*", ""); continue; }
      if (s.synthesis) lines.push(s.synthesis, "");
      if (s.synthesisNote) lines.push(`*${s.synthesisNote}*`, "");
      lines.push("**Evidence**", "", ...s.extracts.map((x) => `- [${x.doc}] "${x.text.replace(/\|/g, "/")}" — ${x.cite}`), "");
    }
    // Evidence table: one row per source, one verbatim extract per column.
    const cols = sections.filter((s) => ["method", "findings", "limits", "data"].includes(s.aspect.id));
    if (cols.length) {
      lines.push("## Evidence table", "", `| Source | ${cols.map((c) => c.aspect.title).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
      for (const src of sources) {
        const k = label.get(src.doc.id)!;
        lines.push(`| [${k}] ${src.doc.title.slice(0, 60).replace(/\|/g, "/")} | ${cols.map((c) => { const x = c.extracts.find((e) => e.doc === k); return x ? `${x.text.slice(0, 160).replace(/\|/g, "/")}${x.text.length > 160 ? "…" : ""}` : "—"; }).join(" | ")} |`);
      }
      lines.push("");
    }
    const gaps = sections.filter((s) => !s.extracts.length).map((s) => s.aspect.title);
    const thin = sources.length < 3 ? [`Only ${sources.length} matching source(s) were found; conclusions are narrow.`] : [];
    lines.push("## Coverage and limitations of this report", "", `- Aspects with evidence: ${covered} of ${sections.length}.`, ...gaps.map((g) => `- No indexed evidence for: ${g}.`), ...thin.map((t) => `- ${t}`), ...notes.map((n) => `- ${n}`),
      "- Contradictions are only reported where the model noticed them in the extracts; compare the evidence table yourself before relying on a comparison.", "");
  }
  const md = lines.join("\n");
  const reportName = version === 1 ? "report.md" : `report-v${version}.md`;
  const reportPath = path.join(projDir, reportName);
  fs.writeFileSync(reportPath, md, "utf8");
  const sha = createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex");
  fs.writeFileSync(path.join(projDir, `evidence-v${version}.json`), JSON.stringify({ sources: sources.map((s) => ({ label: label.get(s.doc.id), title: s.doc.title, path: s.doc.path })), sections: sections.map((s) => ({ aspect: s.aspect.id, extracts: s.extracts })) }, null, 2), "utf8");
  const project: ResearchProject = existing
    ? { ...existing, versions: [...existing.versions, { version, createdAt: stamp, report: reportName, sha256: sha, sources: sources.length, modelSections }] }
    : { id, topic: req.topic, question: req.question, type: req.type, collections: req.collections, latest: req.latest, createdAt: stamp, versions: [{ version, createdAt: stamp, report: reportName, sha256: sha, sources: sources.length, modelSections }] };
  fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(project, null, 2), "utf8");
  return { project, reportPath, sha256: sha, sources: sources.map((s) => s.doc), aspectsWithEvidence: covered, aspectsTotal: sections.length, modelSections, notes };
}
