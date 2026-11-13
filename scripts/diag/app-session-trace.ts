// Diagnostic (no desktop input, no HUD): "Open Notepad and type HELLO" through the REAL runtime and the REAL local model with a fake daemon that
// reports the launch and the typing as performed + verified. Prints the plan and the calls the daemon would have received.
//   npx tsx scripts/diag/app-session-trace.ts [runs]
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import type { ToolPermission } from "../../agent/runtime/types";

const ROOT = path.resolve(__dirname, "..", "..");
const objective = process.env.OBJ ?? "Open Notepad and type HELLO";
class Fake implements DesktopBridge {
  available = true; calls: string[] = [];
  async call(_t: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push(`${tool} ${JSON.stringify(args)}`);
    if (tool === "desktop.launch_app") return { status: "ok", result: { launched: true, verified: true, executed: true, observed: 'a new Notepad window titled "Untitled - Notepad" is open' } } as DesktopReply;
    return { status: "ok", result: { executed: true, verified: true, observed: "typed", control: { controlType: "Document", name: "Text editor" }, target: { process: "Notepad.exe", title: "Untitled - Notepad", pid: 1 } } } as DesktopReply;
  }
}
async function main() {
  const runs = Number(process.argv[2] ?? 3);
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", modelId: process.env.DASK_LOCAL_MODEL || undefined });
  try {
    for (let i = 0; i < runs; i++) {
      const d = new Fake();
      const granted = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
      const rt = new AgentRuntime({ model: new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 }), registry: createDefaultRegistry(ROOT, { desktop: d }), granted, conversation: true, limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 } });
      const t0 = Date.now();
      const r = await rt.run({ taskId: `app${i}`, objective, sink: { emit: (e: any) => { if (e.type === "plan") console.log(`  plan#${e.iteration} ${e.plan.intent}: ${e.plan.steps.map((s: any) => s.tool).join(" -> ")}`); } } });
      console.log(`RUN ${i}: ${r.outcome} verified=${r.verification?.independentlyVerified} ${Date.now() - t0}ms\n  ${d.calls.join("\n  ")}`);
    }
  } finally { await sup.stop("diag done"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
