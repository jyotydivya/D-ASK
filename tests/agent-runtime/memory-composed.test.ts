/**
 * "<knowledge question>? Then remember it." — remembering a VERIFIED knowledge answer with its subject, and recalling it by subject.
 * Found by the offline voice acceptance run results/offline-voice-chain/20261113T234604: S2 stored only "16 November 2026. (source: Project
 * notes)" (no subject, no tags), so S3 "What do you remember about the evaluation deadline?" found nothing.
 * Isolated temporary SQLite database; real AgentRuntime with a scripted model; no network.
 * Run with: npx tsx tests/agent-runtime/memory-composed.test.ts
 *   K. knowledge answer -> memory (subject kept, grounded only)   U. ungrounded / model-made memory refused
 *   R. recall by subject                                          X. exact-user-word remember unchanged
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { createHostRegistry as createDefaultRegistry } from "../../agent/runtime/hostRegistry";
import { MemoryStore } from "../../agent/runtime/memory/memoryStore";
import { rememberedContent, tagsFor } from "../../agent/runtime/tools/memory";
import { sinkObjective, subjectOf } from "../../agent/host/compose";
import type { Artifact, LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dask-memory-composed-"));
const ROOT = process.cwd();
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "memory:read", "memory:write"]);
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? this.plans[0] : SAT); }
}
const plan = (tool: string, input: Record<string, unknown>) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: [{ id: "s1", description: tool, tool, input, dependsOn: [] }] });
const run = (s: MemoryStore, objective: string, tool: string, input: Record<string, unknown>) =>
  new AgentRuntime({ model: new Scripted([plan(tool, input)]), registry: createDefaultRegistry(ROOT, { memory: s }), granted: GRANTS }).run({ taskId: `t${Math.random()}`, objective });

/** The knowledge engine's answer artifact for S2, exactly as service.ts builds it (text = the validated answer, cited source, grounding). */
const kbAnswer = (grounding: NonNullable<Artifact["provenance"]["grounding"]>, text = "16 November 2026 [1]."): Artifact => ({
  kind: "answer", text, sources: [{ label: "Project notes", ref: "project-notes.md" }],
  provenance: { tool: "knowledge.answer", objective: "According to my research papers, when is the de-ask evaluation deadline?", outcome: "completed", verified: null, online: false, at: "2026-11-13T18:18:41Z", grounding, question: "when is the de-ask evaluation deadline" },
});
const S2_CONTENT = "D-ASK evaluation deadline: 16 November 2026. (source: Project notes)";

async function main() {
  const s = new MemoryStore(path.join(dir, "memory.db"));

  console.log("\n[K] a verified knowledge answer, then \"remember it\"");
  check(subjectOf("when is the de-ask evaluation deadline") === "D-ASK evaluation deadline", "K1 the subject is the user's question without its head; the product name written one way", subjectOf("when is the de-ask evaluation deadline"));
  check(subjectOf("What is the DASK release date?") === "D-ASK release date" && subjectOf("how does GraphSAGE aggregate") === "how does GraphSAGE aggregate", "K2 other questions: the head is removed only when it is a plain 'what/when/... is the' head");
  const built = sinkObjective({ kind: "memory" }, kbAnswer("grounded"));
  check("objective" in built && rememberedContent(built.objective) === S2_CONTENT, "K3 the memory request carries the subject, the cited answer and its source", built);
  const r = await run(s, (built as { objective: string }).objective, "memory.remember", { content: S2_CONTENT });
  const saved = s.exportAll();
  check(r.outcome === "completed" && r.verification?.independentlyVerified === true, "K4 stored through the ordinary remember path: completed and independently verified", { o: r.outcome, u: r.verification?.unexplained });
  check(saved.length === 1 && saved[0]!.content === S2_CONTENT && saved[0]!.kind === "project", "K5 the stored text is exactly the composed text", saved);
  check(JSON.stringify(saved[0]!.tags) === JSON.stringify(["d-ask", "evaluation", "deadline"]), "K6 tags from the subject: d-ask, evaluation, deadline", saved[0]!.tags);

  console.log("\n[R] recall by subject (the answer itself is not in the question)");
  for (const q of ["What do you remember about the evaluation deadline?", "D-ASK deadline"]) {
    const hits = s.recall(q, { touch: false });
    check(hits[0]?.content === S2_CONTENT, `R "${q}" -> the saved deadline`, hits.map((h) => h.content));
  }
  const rr = await run(s, "What do you remember about the evaluation deadline?", "memory.recall", { query: "What do you remember about the evaluation deadline?" });
  check(rr.outcome === "completed" && /16 November 2026/.test(JSON.stringify(rr.steps)), "R3 the real recall tool (S3) returns it", { o: rr.outcome });
  check(s.recall("joke about cats", { touch: false }).length === 0, "R4 an unrelated question still finds nothing");

  console.log("\n[U] ungrounded or model-made memory is refused");
  for (const g of ["partially-grounded", "insufficient", "extractive"] as const) {
    const b = sinkObjective({ kind: "memory" }, kbAnswer(g, "16 November 2026 [1]. It was probably moved (model inference; not found in the retrieved passages)."));
    check("refuse" in b && /not fully supported/.test(b.refuse), `U1 a ${g} knowledge answer is not remembered`, b);
  }
  check("refuse" in sinkObjective({ kind: "memory" }, { ...kbAnswer("grounded"), provenance: { ...kbAnswer("grounded").provenance, grounding: undefined } }), "U2 a knowledge answer without a recorded citation check is not remembered (fail closed)");
  const before = s.count();
  const bad = await run(s, (built as { objective: string }).objective, "memory.remember", { content: "D-ASK evaluation deadline: 30 November 2026" });
  check(bad.outcome !== "completed" && s.count() === before && !s.exportAll().some((e) => /30 November/.test(e.content)), "U3 the model cannot store its own version of the answer (contradicted by the request; nothing written)", { o: bad.outcome });
  const bad2 = await run(s, "What is the evaluation deadline?", "memory.remember", { content: "The evaluation deadline is 16 November 2026" });
  check(bad2.outcome !== "completed" && s.count() === before, "U4 no remember request: the model cannot write memory at all", { o: bad2.outcome });
  check("refuse" in sinkObjective({ kind: "memory" }, kbAnswer("grounded", "The admin password is hunter22 [1].")), "U5 secrets are still refused");

  console.log("\n[X] exact-user-word remember is unchanged");
  const x = await run(s, "Remember that my sister's name is Asha.", "memory.remember", { content: "my sister's name is Asha" });
  const asha = s.exportAll().find((e) => /Asha/.test(e.content));
  check(x.outcome === "completed" && asha?.content === "my sister's name is Asha" && asha.tags.length === 0, "X1 stored exactly as said, with no tags", asha);
  const y = await run(s, "Remember that the wifi room: second floor", "memory.remember", { content: "the wifi room: second floor" });
  check(y.outcome === "completed" && JSON.stringify(s.exportAll().find((e) => /wifi/.test(e.content))?.tags) === "[]", "X2 a user's own colon is not a composed result: no tags");
  check(tagsFor("my sister's name is Asha").length === 0 && tagsFor(S2_CONTENT).join() === "d-ask,evaluation,deadline", "X3 tags only for the composed '<subject>: <answer> (source: …)' form");
  const z = await run(s, "Remember that I like jazz", "memory.remember", { content: "I like music" });
  check(z.outcome !== "completed" && s.recall("music", { touch: false }).length === 0, "X4 content other than the user's words is still refused");

  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
