// Diagnostic (no desktop, no HUD): the questions below through the REAL runtime and the REAL local model, conversation path on.
// Prints outcome, response and the model calls used. Nothing touches the desktop; one local llama-server is started and stopped.
//   npx tsx scripts/diag/conversation-trace.ts
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";

const ROOT = path.resolve(__dirname, "..", "..");
const QUESTIONS = process.env.QS ? process.env.QS.split("|") : ["WHAT IS SEVEN TIMES EIGHT", "What is seven times eight?", "What is the capital of France?", "Why is the sky blue?", "Delete my notes", "What is the weather in Pune?"];

async function main() {
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", modelId: process.env.DASK_LOCAL_MODEL || undefined });
  try {
    const inner = new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 });
    const calls: string[] = [];
    const model = { name: inner.name, generateJson: (req: any) => { calls.push(req.purpose); return inner.generateJson(req); } };
    const rt = new AgentRuntime({ model, registry: createDefaultRegistry(ROOT), granted: DEFAULT_GRANTS, conversation: true, limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 } });
    let i = 0;
    for (const q of QUESTIONS) {
      calls.length = 0; const t0 = Date.now();
      const r = await rt.run({ taskId: `conv${++i}`, objective: q });
      console.log(`\nQ: ${q}\n  outcome=${r.outcome} verified=${r.verification?.independentlyVerified ?? "n/a"} calls=[${calls.join(",")}] tools=${r.toolCalls} ${Date.now() - t0}ms\n  response: ${r.response.replace(/\n/g, " | ")}`);
    }
  } finally { await sup.stop("diag done"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
