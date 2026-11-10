// Diagnostic (no desktop input): run the multi-step input request through the REAL runtime and the REAL local model,
// with a fake daemon that reports every input as performed + verified. Prints the plan/verification trace so planner
// behaviour on ordered input sequences can be inspected. Nothing touches the desktop.
//   npx tsx scripts/diag/multistep-plan-trace.ts [runs]
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import type { ToolPermission } from "../../agent/runtime/types";

const ROOT = path.resolve(__dirname, "..", "..");
const T = "DASK Input Fixture 9a3968";
const objective = process.env.OBJ ?? `Type "hi" into the notes field of the window titled "${T}", then press Backspace`;

class FakeDaemon implements DesktopBridge {
  available = true;
  calls: string[] = [];
  async call(_t: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push(`${tool} ${JSON.stringify(args)}`);
    return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: true, observed: "verified by fake",
      control: { controlType: "Edit", automationId: "notes", name: "" }, keys: (args as any).keys, target: { process: "powershell.exe", title: T, pid: 1 } } };
  }
}

async function main() {
  const runs = Number(process.argv[2] ?? 1);
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", modelId: process.env.DASK_LOCAL_MODEL || undefined });
  try {
    for (let i = 0; i < runs; i++) {
      const d = new FakeDaemon();
      const granted = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
      const rt = new AgentRuntime({ model: new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 }),
        registry: createDefaultRegistry(ROOT, { desktop: d }), granted, limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 } });
      const t0 = Date.now();
      const r = await rt.run({ taskId: `diag${i}`, objective, sink: { emit: (e: any) => {
        if (e.type === "plan") console.log(`  plan#${e.iteration} ${e.plan.intent}: ${e.plan.steps.map((s: any) => `${s.tool}${JSON.stringify(s.input)}`).join(" | ")} removed=${JSON.stringify(e.plan.removedDuplicateSteps ?? [])}`);
        if (e.type === "step.finished") console.log(`  step ${e.stepId} ${e.tool} ${e.status} ${e.error ?? ""}`);
        if (e.type === "verification") console.log(`  verify needsMore=${e.report.needsMoreSteps} crit=${e.report.criteriaSatisfied} indep=${e.report.independentlyVerified} facets=${JSON.stringify(e.report.facets.map((f: any) => [f.id.slice(0, 40), f.satisfied]))}`);
      } } });
      console.log(`RUN ${i}: ${r.outcome} iterations=${r.iterations} calls=${d.calls.length} ${Date.now() - t0}ms\n  ${d.calls.join("\n  ")}`);
    }
  } finally { await sup.stop("diag done"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
