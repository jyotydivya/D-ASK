/**
 * LIVE (real files, no fakes): "Find a PDF and summarise it" through D-ASK's own filesystem tools, as the agent runs them. The folder is
 * read-only (a copy of real research papers from the offline voice acceptance library). The summary's quoted sentences are then
 * re-verified by the tool's own independent check, which re-reads the PDF. No network, no model.
 * Run with: npx tsx tests/agent-runtime/pdf-summary.live.ts <folder with PDFs> <evidence.json>
 */
import { writeFileSync } from "node:fs";
import { FileAccess, createSearchTool } from "../../agent/runtime/tools/filesystem";
import { createSummarizeTool } from "../../agent/runtime/tools/fileSummary";

async function main() {
  const [folder, out] = process.argv.slice(2);
  if (!folder || !out) { console.error("usage: pdf-summary.live.ts <folder> <evidence.json>"); process.exit(2); }
  const ctx = { taskId: "pdf-live", stepId: "s1", signal: new AbortController().signal } as any;
  const access = new FileAccess({ workspaceRoot: folder });
  const t0 = Date.now();
  const found = await createSearchTool(access).execute({ extension: "pdf" } as any, ctx);
  const pdfs: string[] = (found.output as any)?.matches?.map((m: any) => m.path) ?? [];
  const summarize = createSummarizeTool(access);
  const target = pdfs[0];
  const sum = target ? await summarize.execute({ path: target, maxSentences: 4 } as any, ctx) : null;
  const verdict = sum ? summarize.check!({ path: target! } as any, sum) : { ok: false, reason: "no PDF found" };
  const evidence = {
    request: "Find a PDF and summarize it.", capabilities: ["filesystem.search", "filesystem.summarize"], ms: Date.now() - t0,
    found: pdfs, summarised: target ?? null, ok: !!sum?.ok, independentCheck: verdict,
    keySentences: (sum?.output as any)?.keySentences ?? [], words: (sum?.output as any)?.words ?? null, evidence: sum?.evidence ?? sum?.error ?? null,
  };
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ found: pdfs.length, summarised: target, ok: evidence.ok, check: verdict, sentences: evidence.keySentences.length }));
  process.exit(evidence.ok && verdict.ok && evidence.keySentences.length > 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
