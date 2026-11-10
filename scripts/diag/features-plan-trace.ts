// Diagnostic: the REAL local model on the two requests that did not complete in the real-HUD feature run (2026-11-10):
// "Undo the last file organisation" (fake daemon that reports a verified undo) and a word-count request (real plugin
// sandbox, sample plugin approved in a temp folder). Prints plans, step results and the final response. Nothing moves.
//   npx tsx scripts/diag/features-plan-trace.ts
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import { PluginManager } from "../../agent/runtime/plugins/pluginManager";
import type { ToolPermission } from "../../agent/runtime/types";

const ROOT = path.resolve(__dirname, "..", "..");
async function main() {
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", modelId: process.env.DASK_LOCAL_MODEL || undefined });
  const bridge = {
    available: true, offers: (t: string) => t.startsWith("files.") || t.startsWith("plugins."),
    call: async (_t: string, tool: string) => tool === "files.undo_organize"
      ? { status: "ok" as const, result: { decision: "approved", consumed: true, executed: true, verified: true, moved: 3, total: 3, folder: "C:\\x", moves: [{ name: "report.pdf", from: "Documents", done: true }] } }
      : { status: "error" as const, error: { code: "x", message: "not used" } },
  };
  const TMP = mkdtempSync(path.join(os.tmpdir(), "dask-diag-plugins-"));
  const dir = path.join(TMP, "text_tools"); await fs.mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const n of readdirSync(path.join(ROOT, "plugins-samples/text_tools"))) { const b = readFileSync(path.join(ROOT, "plugins-samples/text_tools", n)); await fs.writeFile(path.join(dir, n), b); files[n] = createHash("sha256").update(b).digest("hex"); }
  await fs.writeFile(path.join(TMP, "approved.json"), JSON.stringify([{ id: "text_tools", version: "1.0.0", files }]));
  const registry = createDefaultRegistry(ROOT, { desktop: bridge });
  await new PluginManager({ pluginsDir: TMP, approvedPath: path.join(TMP, "approved.json"), runtimeDir: path.join(ROOT, "agent/runtime/plugins") }).sync(registry);
  const granted = new Set<ToolPermission>([...DEFAULT_GRANTS, "request:desktop_action"]);
  try {
    for (const objective of ["Undo the last file organisation", "Give me the word count of: alpha beta gamma delta"]) {
      const rt = new AgentRuntime({ model: new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 }), registry, granted, limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 } });
      const r = await rt.run({ taskId: `diag${Math.random()}`.replace(".", ""), objective, sink: { emit: (e: any) => {
        if (e.type === "plan") console.log(`  plan#${e.iteration} ${e.plan.intent}: ${e.plan.steps.map((s: any) => `${s.tool}${JSON.stringify(s.input)}`).join(" | ")}`);
        if (e.type === "step.finished") console.log(`  step ${e.stepId} ${e.tool} ${e.status} ${e.error ?? ""}`);
      } } });
      console.log(`== ${objective}\n   outcome=${r.outcome}\n   ${r.response.split("\n").join("\n   ")}\n`);
    }
  } finally { await sup.stop("diag done"); await fs.rm(TMP, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((e) => { console.error(e); process.exit(1); });
