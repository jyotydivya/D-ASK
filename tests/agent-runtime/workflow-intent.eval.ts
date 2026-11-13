/**
 * Real-model evaluation of natural-language workflow management through the REAL AgentHost.
 *   npx tsx tests/agent-runtime/workflow-intent.eval.ts --set dev|heldout [--model <id>] [--only U1,L2]
 * The local model (llama-server via the InferenceSupervisor, its memory guard unchanged) describes each request; the host validates it; a fake
 * daemon records exactly which daemon calls result. Nothing is mocked except the daemon. The report distinguishes what the MODEL said
 * (raw operation) from what the whole PIPELINE did (final daemon call or question), and counts any wrong action explicitly.
 * Held-out discipline: tests/agent-runtime/fixtures/workflow-intent-heldout.json is for the final measurement only.
 */
import fs from "node:fs";
import path from "node:path";
import { AgentHost } from "../../agent/host/host";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";
import { FakeWorkflowDaemon, type WorldWorkflow } from "./fixtures/fakeWorkflowDaemon";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const SET = arg("set") ?? "dev";
const ONLY = arg("only")?.split(",");
const ROOT = path.resolve(__dirname, "..", "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `workflow-intent-${SET}.json`), "utf8")) as { world: WorldWorkflow[]; cases: Case[] };
interface Case { id: string; cat: string; text: string; accept: ("call" | "clarify" | "none")[]; tool?: string; args?: Record<string, unknown>; minSteps?: number }
const world = fixture.world;
const OP_OF: Record<string, string> = { "workflows.save": "save", "workflows.list": "list", "workflows.delete": "delete", "workflows.schedule": "schedule", "workflows.unschedule": "unschedule" };

class Recording implements LanguageModel {
  readonly name = "recording"; raws: unknown[] = []; errors: string[] = []; ms = 0;
  constructor(private readonly inner: LanguageModel) {}
  async generateJson(req: StructuredRequest) { const t = Date.now(); try { const r = await this.inner.generateJson(req); this.raws.push(r); return r; } catch (e) { this.errors.push(e instanceof Error ? e.message : String(e)); throw e; } finally { this.ms += Date.now() - t; } }
}

async function main() {
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", idleUnloadMs: 0, readyTimeoutMs: 180_000, modelId: arg("model") });
  const model = new Recording(new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 }));
  const daemon = new FakeWorkflowDaemon(world);
  const rows: any[] = [];
  const cases = fixture.cases.filter((c) => !ONLY || ONLY.includes(c.id));
  try {
    for (const c of cases) {
      daemon.reset(world); model.raws = []; model.errors = []; model.ms = 0;
      let planner = 0; const out: any[] = [];
      const host = new AgentHost({
        writeLine: (l) => out.push(JSON.parse(l)), log: () => {}, token: "tok", exit: () => {}, desktop: daemon as any, model,
        runtime: { run: async (o: any) => { planner++; return { taskId: o.taskId, outcome: "completed", plan: null, steps: [], verification: null, response: "(planner)", iterations: 1, toolCalls: 0 }; } } as any,
      });
      host.handleLine(JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "tok", emergencyStopped: false, stopGeneration: 0 } }));
      host.handleLine(JSON.stringify({ v: 1, id: "q1", op: "submit", params: { taskId: `t${c.id}`, objective: c.text } }));
      const t0 = Date.now();
      while (!out.some((x) => x.event === "task.finished") && Date.now() - t0 < 200_000) await new Promise((r) => setTimeout(r, 50));
      const fin = out.find((x) => x.event === "task.finished")?.data;
      const acts = daemon.actions;
      const label: "call" | "clarify" | "none" = planner > 0 ? "none" : acts.length > 0 ? "call" : "clarify";
      const act = acts[0];
      let correct = c.accept.includes(label);
      if (correct && label === "call") {
        const argsOk = Object.entries(c.args ?? {}).every(([k, v]) => JSON.stringify(act?.args?.[k]) === JSON.stringify(v));
        correct = acts.length === 1 && act!.tool === c.tool && argsOk && (c.minSteps === undefined || (act!.args.steps?.length ?? 0) >= c.minSteps);
      }
      const row = { id: c.id, cat: c.cat, text: c.text, expectedAccept: c.accept, expectedTool: c.tool ?? null, label, correct,
        wrongAction: label === "call" && !correct, tool: act?.tool ?? null, args: act?.args ?? null, outcome: fin?.outcome ?? null, response: String(fin?.response ?? "").slice(0, 400),
        rawModel: model.raws, modelErrors: model.errors, modelMs: model.ms, cards: daemon.cardShown };
      rows.push(row);
      console.log(`${correct ? " ok " : "FAIL"} ${c.id.padEnd(4)} ${label.padEnd(7)} ${String(model.ms).padStart(6)}ms  ${c.text}${correct ? "" : `\n        → ${act ? `${act.tool} ${JSON.stringify(act.args)}` : row.response.replace(/\n/g, " ").slice(0, 160)}\n        model: ${(JSON.stringify(model.raws[0] ?? model.errors[0]) ?? '(no model call)').slice(0, 260)}`}`);
    }
  } finally { await sup.stop("eval finished").catch(() => {}); }

  // ── metrics ──
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
  const callCases = rows.filter((r) => r.expectedAccept.length === 1 && r.expectedAccept[0] === "call");
  const noAct = rows.filter((r) => !r.expectedAccept.includes("call"));
  const mustClarify = rows.filter((r) => ["ambiguous", "missing", "invalid", "contradictory"].includes(r.cat));
  const sched = callCases.filter((r) => r.expectedTool === "workflows.schedule");
  const withName = callCases.filter((r) => fixture.cases.find((c) => c.id === r.id)?.args?.name !== undefined);
  const caseOf = (id: string) => fixture.cases.find((c) => c.id === id)!;
  const rawOp = (r: any) => (r.rawModel[0] && typeof r.rawModel[0] === "object" ? (r.rawModel[0] as any).operation : null);
  const metrics = {
    set: SET, model: arg("model") ?? "default (pinned manifest)", cases: rows.length,
    overallCorrect: { n: rows.filter((r) => r.correct).length, of: rows.length, pct: pct(rows.filter((r) => r.correct).length, rows.length) },
    intentAccuracy_pipeline: { note: "expected operation family reached: right tool for operation cases; no action for must-not-act cases", n: rows.filter((r) => (callCases.includes(r) ? r.tool === r.expectedTool : r.label !== "call")).length, of: rows.length },
    modelRawOperation_onActionCases: { note: "what the MODEL alone said (before validation)", n: callCases.filter((r) => rawOp(r) === OP_OF[r.expectedTool]).length, of: callCases.length, pct: pct(callCases.filter((r) => rawOp(r) === OP_OF[r.expectedTool]).length, callCases.length) },
    nameExtraction_final: { n: withName.filter((r) => r.args?.name === caseOf(r.id).args!.name).length, of: withName.length, pct: pct(withName.filter((r) => r.args?.name === caseOf(r.id).args!.name).length, withName.length) },
    nameExtraction_modelRaw: { n: withName.filter((r) => r.rawModel[0]?.workflow_name?.toLowerCase?.() === String(caseOf(r.id).args!.name).toLowerCase()).length, of: withName.length },
    scheduleParams_final: { n: sched.filter((r) => r.correct).length, of: sched.length, pct: pct(sched.filter((r) => r.correct).length, sched.length) },
    ambiguityDetection: { note: "ambiguous/missing/invalid/contradictory requests that ended in a question with NO daemon action", n: mustClarify.filter((r) => r.label === "clarify").length, of: mustClarify.length, pct: pct(mustClarify.filter((r) => r.label === "clarify").length, mustClarify.length) },
    safeRefusalRate: { note: "must-not-act requests (incl. not-workflow) with zero daemon actions", n: noAct.filter((r) => r.label !== "call").length, of: noAct.length, pct: pct(noAct.filter((r) => r.label !== "call").length, noAct.length) },
    correctRouting: { note: "action cases that reached the right daemon tool with the right arguments", n: callCases.filter((r) => r.correct).length, of: callCases.length, pct: pct(callCases.filter((r) => r.correct).length, callCases.length) },
    wrongActions: rows.filter((r) => r.wrongAction).map((r) => ({ id: r.id, text: r.text, tool: r.tool, args: r.args })),
    clarifiedButActionExpected: callCases.filter((r) => r.label !== "call").map((r) => r.id),
    modelErrors: rows.filter((r) => r.modelErrors.length).map((r) => ({ id: r.id, errors: r.modelErrors })),
    perCategory: Object.fromEntries([...new Set(rows.map((r) => r.cat))].map((cat) => [cat, `${rows.filter((r) => r.cat === cat && r.correct).length}/${rows.filter((r) => r.cat === cat).length}`])),
    meanModelMs: Math.round(rows.reduce((a, r) => a + r.modelMs, 0) / Math.max(1, rows.length)),
  };
  const dir = path.join(ROOT, "results", "workflow-intent-eval", `${SET}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(rows, null, 2));
  console.log("\n" + JSON.stringify(metrics, null, 2) + `\nEvidence: ${dir}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
