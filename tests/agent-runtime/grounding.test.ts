/**
 * Deterministic request grounding + fail-closed completion (Phase 4 decision 1).
 * Run with: npx tsx tests/agent-runtime/grounding.test.ts
 *
 *   X. extraction / detection unit checks per tool
 *   Y. planner: contradicted steps are rejected before execution; repair works
 *   Z. outcome rule: the model alone can never establish "completed"
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime";
import { argumentDomainsFor, checkArguments, detectFacets, groundCall } from "../../agent/runtime/grounding";
import { Brain } from "../../agent/runtime/brain";
import { Planner } from "../../agent/runtime/planner";
import { buildPlanSchema } from "../../agent/runtime/inference/schemas";
import { extractExpressions, requestedPaths, requestedZones } from "../../agent/runtime/tools/requestChecks";
import { evaluateArithmetic } from "../../agent/runtime/tools/builtin";
import type { LanguageModel, StructuredRequest, ToolSpec } from "../../agent/runtime/types";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const reg = createDefaultRegistry(ROOT);
const sysZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Step = { id: string; tool: string; input: Record<string, unknown>; dependsOn?: string[]; description?: string };
const plan = (steps: Step[]) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: steps.map((s) => ({ description: s.tool, dependsOn: [], ...s })) });
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "looks done" };
const UNSAT = { criteriaSatisfied: false, missing: ["x"], needsMoreSteps: false, reason: "no" };

class Scripted implements LanguageModel {
  readonly name = "scripted";
  calls: StructuredRequest[] = [];
  constructor(private plans: unknown[], private assess: unknown[]) {}
  async generateJson(req: StructuredRequest) {
    this.calls.push(req);
    const q = req.purpose === "plan" ? this.plans : this.assess;
    const next = q.length > 1 ? q.shift() : q[0];
    return structuredClone(next);
  }
}
const run = (model: LanguageModel, objective: string, extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) =>
  new AgentRuntime({ model, registry: reg, granted: DEFAULT_GRANTS, ...extra }).run({ taskId: `t${Math.random()}`, objective });

async function main(): Promise<void> {
  console.log("\n[X] Detection");
  const ex = (s: string) => extractExpressions(s, evaluateArithmetic).map((e) => `${e.expression}=${e.value}`);
  check(JSON.stringify(ex("What is (17+25)*2?")) === '["(17+25)*2=84"]', "X1 extracts (17+25)*2 = 84", ex("What is (17+25)*2?"));
  check(JSON.stringify(ex("what's 17 x 3 and 10 divided by 4")) === '["17*3=51","10/4=2.5"]', "X2 spoken operators and two expressions", ex("what's 17 x 3 and 10 divided by 4"));
  check(JSON.stringify(ex("compute 1,000*2")) === '["1000*2=2000"]', "X3 thousands separators", ex("compute 1,000*2"));
  check(ex("what happened on 2026-11-02 and 11/02/2026").length === 0, "X4 dates are not arithmetic");
  check(ex("list the files in agent/runtime").length === 0 && ex("what is 42").length === 0, "X5 paths and bare numbers are not arithmetic");
  check(groundCall(reg, "math.evaluate", { expression: "17+25*2" }, "What is (17+25)*2?").status === "contradicted", "X6 17+25*2 contradicts a request for (17+25)*2");
  check(groundCall(reg, "math.evaluate", { expression: "( 17 + 25 ) * 2" }, "What is (17+25)*2?").status === "grounded", "X7 same expression with different spacing is grounded");
  check(groundCall(reg, "math.evaluate", { expression: "42*2" }, "What is (17+25)*2?").status === "grounded", "X8 an equal-valued rewrite is grounded (checked by value)");
  check(groundCall(reg, "math.evaluate", { expression: "365*24" }, "how many hours in a year?").status === "ungrounded", "X9 arithmetic the request never wrote is ungrounded (not contradicted)");

  check(requestedZones("what time is it in Tokyo?").some((z) => z.zones.includes("Asia/Tokyo")), "X10 'Tokyo' → Asia/Tokyo from the runtime tz database");
  check(groundCall(reg, "system.time", {}, "what time is it in Tokyo?").status === "contradicted", "X11 local time for a Tokyo question is contradicted");
  check(groundCall(reg, "system.time", { timeZone: "Asia/Tokyo" }, "what time is it in Tokyo?").status === "grounded", "X12 Asia/Tokyo for a Tokyo question is grounded");
  check(groundCall(reg, "system.time", { timeZone: "Europe/Paris" }, "what time is it?").status === (sysZone === "Europe/Paris" ? "grounded" : "contradicted"), "X13 an invented zone for a plain time question is contradicted");
  check(groundCall(reg, "system.time", { timeZone: sysZone }, "what time is it?").status === "grounded", "X14 the system's own zone is grounded");
  check(groundCall(reg, "system.time", {}, "how much RAM do I have?").status === "ungrounded", "X15 a time call for a RAM question is ungrounded");

  check(detectFacets(reg, "how much RAM and how many CPU cores?").map((f) => f.id).sort().join(",") === "info:cpu,info:memory", "X16 info facets: memory + cpu");
  check(JSON.stringify(requestedPaths("what is in agent/runtime and the docs folder?").sort()) === '["agent/runtime","docs"]', "X17 path facets: slash path + 'the X folder'", requestedPaths("what is in agent/runtime and the docs folder?"));
  check(groundCall(reg, "workspace.list_dir", { path: "agent" }, "list the files in agent/runtime").status === "contradicted", "X18 listing a different folder is contradicted");
  check(groundCall(reg, "workspace.list_dir", { path: "agent\\runtime\\" }, "list the files in agent/runtime").status === "grounded", "X19 path normalisation (backslashes, trailing slash)");
  check(groundCall(reg, "workspace.list_dir", {}, "list the project root").status === "grounded", "X20 root listing when the request asks for the project root");
  check(detectFacets(reg, "send an email to my boss").length === 0, "X21 nothing detectable → no facets");

  console.log("\n[Y] Planner rejects contradicted steps before execution");
  {
    const m = new Scripted([plan([{ id: "s1", tool: "math.evaluate", input: { expression: "17+25*2" } }]), plan([{ id: "s1", tool: "math.evaluate", input: { expression: "(17+25)*2" } }])], [SAT]);
    const r = await run(m, "What is (17+25)*2?");
    const planCalls = m.calls.filter((c) => c.purpose === "plan");
    check(planCalls.length === 2 && /not taken from the request; allowed: "\(17\+25\)\*2"/.test(planCalls[1].user), "Y1 the argument violation (with the allowed value) is fed back into the repair round", planCalls[1]?.user.slice(-300));
    check(r.outcome === "completed" && r.steps.length === 1 && r.steps[0].outcome?.evidence === "(17+25)*2 = 84", "Y1 repaired plan runs and completes with the right answer", { outcome: r.outcome, ev: r.steps[0]?.outcome?.evidence });
  }
  {
    const m = new Scripted([plan([{ id: "s1", tool: "math.evaluate", input: { expression: "17+25*2" } }])], [SAT]);
    const r = await run(m, "What is (17+25)*2?");
    check(r.outcome === "failed" && r.steps.length === 0 && /not taken from the request/.test(r.error ?? ""), "Y2 a model that keeps the wrong expression → planning fails, nothing executes", { outcome: r.outcome, error: r.error });
  }

  console.log("\n[Z] Fail-closed outcome rule");
  {
    // Ablation: planner grounding OFF → the wrong call executes; verification still refuses completion.
    const m = new Scripted([plan([{ id: "s1", tool: "math.evaluate", input: { expression: "17+25*2" } }])], [SAT]);
    const r = await run(m, "What is (17+25)*2?", { argumentConstraints: false, limits: { maxIterations: 1 } });
    check(r.outcome === "partial" && r.verification?.grounding[0]?.status === "contradicted", "Z1 (ablation: argument constraints off) wrong expression executed + model 'satisfied' → partial, never completed", { outcome: r.outcome, g: r.verification?.grounding });
    const rg = await run(new Scripted([plan([{ id: "s1", tool: "math.evaluate", input: { expression: "17+25*2" } }])], [SAT]), "What is (17+25)*2?", { argumentConstraints: false, experimental: { gapReplanning: true }, limits: { maxIterations: 1 } });
    check(rg.verification!.needsMoreSteps && rg.verification!.missing.some((x) => /answered something else/.test(x)), "Z1 with experimental gapReplanning the contradiction is reported as a gap");
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "do the thing we discussed");
    check(r.outcome === "unverified" && r.verification?.independentlyVerified === false, "Z2 request with no detectable facet + model 'satisfied' → unverified", r.outcome);
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [UNSAT]), "What time is it?");
    check(r.outcome === "partial", "Z3 grounded + covered, but the model disagrees → partial (model can downgrade)", r.outcome);
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [{ nonsense: true }]), "What time is it?");
    check(r.outcome === "unverified", "Z4 independently verified, but the model assessment is malformed → unverified (both are required)", r.outcome);
  }
  {
    // Uncovered facet triggers a follow-up round; the round is told what is still required.
    const m = new Scripted([
      plan([{ id: "s1", tool: "system.time", input: {} }]),
      plan([{ id: "s1", tool: "math.evaluate", input: { expression: "17*3" } }]),
    ], [SAT]);
    const r = await run(m, "What time is it and what is 17*3?", { experimental: { gapReplanning: true } });
    const second = m.calls.filter((c) => c.purpose === "plan")[1];
    check(!!second && /STILL REQUIRED: evaluate 17\*3/.test(second.user), "Z5 (experimental gapReplanning) the uncovered facet is passed to follow-up planning", second?.user.slice(-200));
    check(r.outcome === "completed" && r.iterations === 2, "Z5 second round covers it → completed", { outcome: r.outcome, it: r.iterations });
    const rd = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "What time is it and what is 17*3?");
    check(rd.outcome === "unverified" && rd.iterations === 1, "Z5b product default (gapReplanning off): uncovered facet → unverified, no extra round", { outcome: rd.outcome, it: rd.iterations });
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "What time is it and what is 17*3?", { limits: { maxIterations: 1 } });
    check(r.outcome === "unverified" && r.verification!.facets.some((f) => !f.satisfied), "Z6 a facet left uncovered (no budget for another round) → unverified", r.outcome);
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.info", input: {} }, { id: "s2", tool: "system.time", input: {} }])], [SAT]), "How much RAM do I have?", { limits: { maxIterations: 1 } });
    check(r.outcome === "unverified", "Z7 an extra step the request does not justify → unverified", r.outcome);
  }
  {
    const opaque: ToolSpec = { name: "test.opaque", description: "d", inputSchema: { type: "object", properties: {} }, permissions: ["compute"], risk: "low", requiresApproval: false, timeoutMs: 500, async execute() { return { ok: true, evidence: "did it" }; } };
    const reg2 = createDefaultRegistry(ROOT).register(opaque);
    const r = await new AgentRuntime({ model: new Scripted([plan([{ id: "s1", tool: "test.opaque", input: {} }])], [SAT]), registry: reg2, granted: DEFAULT_GRANTS }).run({ taskId: "z8", objective: "What time is it?" });
    check(r.outcome === "unverified", "Z8 a tool without a request check can never yield completed", r.outcome);
  }
  {
    const r = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: { timeZone: "Asia/Tokyo" } }, { id: "s2", tool: "workspace.list_dir", input: { path: "agent/runtime" } }])], [SAT]), "What time is it in Tokyo, and what is in agent/runtime?");
    check(r.outcome === "completed" && r.verification!.facets.length === 2, "Z9 multi-tool request fully grounded and covered → completed", { outcome: r.outcome, f: r.verification?.facets });
  }

  // ── D. Runtime-generated dependencies ──────────────────────────────────────
  console.log("\n[D] Dependencies are generated by the runtime, never taken on the model's authority");
  {
    const planner = new Planner(new Brain(new Scripted([], []), 1_000), reg);
    const chk = (steps: Step[]) => planner.check({ intent: "task", goal: "g", successCriteria: [], steps: steps.map((s) => ({ description: s.tool, ...s })) }, { maxSteps: 8, granted: DEFAULT_GRANTS, objective: "What time is it and how much RAM do I have?" });
    const errs = (r: ReturnType<typeof chk>) => (r.ok ? [] : (r as { errors: string[] }).errors);
    const self = chk([{ id: "s1", tool: "system.time", input: {}, dependsOn: ["s1"] }]);
    check(!self.ok && errs(self).some((e) => /depends on itself/.test(e)), "D1 self-dependency → rejected explicitly", errs(self));
    const cycle = chk([{ id: "s1", tool: "system.time", input: {}, dependsOn: ["s2"] }, { id: "s2", tool: "system.info", input: {}, dependsOn: ["s1"] }]);
    check(!cycle.ok && errs(cycle).some((e) => /s1: dependsOn "s2" is not an earlier step/.test(e)), "D2 cycle (s1↔s2) → rejected explicitly", errs(cycle));
    const fwd = chk([{ id: "s1", tool: "system.time", input: {}, dependsOn: ["s3"] }, { id: "s2", tool: "system.info", input: {} }]);
    check(!fwd.ok && errs(fwd).some((e) => /"s3" is not an earlier step/.test(e)), "D3 dependency on a later/unknown step → rejected explicitly", errs(fwd));
    const ok = chk([{ id: "s1", tool: "system.time", input: {} }, { id: "s2", tool: "system.info", input: {} }, { id: "s3", tool: "system.time", input: {} }]);
    check(ok.ok && JSON.stringify((ok as { plan: { steps: { dependsOn: string[] }[] } }).plan.steps.map((s) => s.dependsOn)) === '[[],["s1"],["s2"]]', "D4 valid multi-step plan without dependsOn → accepted; sequential dependencies generated", ok.ok ? (ok as { plan: { steps: unknown[] } }).plan.steps : errs(ok));
    const backward = chk([{ id: "s1", tool: "system.time", input: {} }, { id: "s2", tool: "system.info", input: {}, dependsOn: ["s1"] }]);
    check(backward.ok, "D5 a consistent backward dependsOn is accepted (already implied by sequential order)");
    for (const ref of ["{{s1.output}}", "${s1}", "$s1", "s1.result", "step 1.value", "the output of step 1", "result.time.split(' ')[1]", "output[0]", "previous.value"]) {
      const r = chk([{ id: "s1", tool: "system.time", input: {} }, { id: "s2", tool: "math.evaluate", input: { expression: ref } }]);
      check(!r.ok && errs(r).some((e) => /references another step's result/.test(e)), `D6 input referencing another step's result (${ref}) → rejected, not silently dropped`, errs(r));
    }
    const fileLike = planner.check({ intent: "task", goal: "g", successCriteria: [], steps: [{ id: "s1", description: "l", tool: "workspace.list_dir", input: { path: "build/output.json" } }] }, { maxSteps: 8, granted: DEFAULT_GRANTS });
    check(fileLike.ok, "D6b a dotted name such as build/output.json is not mistaken for a step reference", fileLike.ok ? null : (fileLike as { errors: string[] }).errors);
    const multi = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }, { id: "s2", tool: "math.evaluate", input: { expression: "17*3" } }])], [SAT]), "What time is it and what is 17*3?");
    check(multi.outcome === "completed" && multi.steps.every((s) => s.status === "succeeded"), "D7 valid two-step plan runs end to end → completed", multi.outcome);
  }

  // ── T. Time zone: resolved deterministically, never invented by the model ──
  console.log("\n[T] Time zone resolution");
  {
    const dPlain = argumentDomainsFor(reg, "What time is it?")["system.time"]?.timeZone;
    check(dPlain?.kind === "forbidden", "T1 no zone named → timeZone forbidden (local time)", dPlain);
    const schemaPlain = buildPlanSchema(reg.listUsable(DEFAULT_GRANTS), 8, argumentDomainsFor(reg, "What time is it?")) as any;
    const timeVariant = schemaPlain.properties.steps.items.anyOf.find((v: any) => v.properties.tool.const === "system.time");
    check(!("timeZone" in timeVariant.properties.input.properties), "T1 the output schema offers no timeZone, so a constrained model cannot invent one");
    check(checkArguments(argumentDomainsFor(reg, "What time is it?"), "system.time", { timeZone: "IST" }) !== null, "T2 an invented zone (IST) fails the pre-execution argument check");
    const m = new Scripted([plan([{ id: "s1", tool: "system.time", input: { timeZone: "local" } }]), plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]);
    const r = await run(m, "What time is it?");
    check(r.outcome === "completed" && m.calls.filter((c) => c.purpose === "plan").length === 2 && /must be omitted/.test(m.calls[1].user), "T3 'What time is it?' with invalid timeZone → rejected with the reason, repaired, completed", { outcome: r.outcome });
    const dTokyo = argumentDomainsFor(reg, "What time is it in Tokyo?")["system.time"]?.timeZone;
    check(dTokyo?.kind === "enum" && dTokyo.values.includes("Asia/Tokyo"), "T4 named city → timeZone restricted to its IANA zone", dTokyo);
    check(checkArguments(argumentDomainsFor(reg, "What time is it in Tokyo?"), "system.time", { timeZone: "Europe/Paris" }) !== null, "T4 a different zone fails the argument check");
    const rt = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "What time is it in Tokyo?");
    check(rt.outcome !== "completed", "T5 Tokyo requested but local time returned → never completed", rt.outcome);
    const morning = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "Is it morning or evening for me right now?");
    check(morning.outcome === "completed" && morning.verification!.facets.some((f) => f.id === "time:local"), "T6 regression (Phase 4 p05): 'morning or evening?' is recognised as a local-time request → completed", { outcome: morning.outcome, f: morning.verification?.facets });
  }

  // ── P. Expression preservation ─────────────────────────────────────────────
  console.log("\n[P] Arithmetic: the requested expression is preserved exactly");
  {
    const dom = (o: string) => argumentDomainsFor(reg, o)["math.evaluate"]?.expression;
    const vals = (o: string) => { const d = dom(o); return d && d.kind === "enum" ? [...d.values] : []; };
    check(JSON.stringify(vals("What is (17+25)*2?")) === '["(17+25)*2"]', "P1 parentheses preserved in the allowed expression", vals("What is (17+25)*2?"));
    check(JSON.stringify(vals("Compute ((2+3)*(4-1))^2 please")) === '["((2+3)*(4-1))^2"]' && evaluateArithmetic("((2+3)*(4-1))^2") === 225, "P2 nested parentheses", vals("Compute ((2+3)*(4-1))^2 please"));
    check(JSON.stringify(vals("what is 2+3*4 and what is (2+3)*4?")) === '["2+3*4","(2+3)*4"]', "P3 precedence: 2+3*4 and (2+3)*4 are kept distinct", vals("what is 2+3*4 and what is (2+3)*4?"));
    check(JSON.stringify(vals("what is -5+3?")) === '["-5+3"]' && vals("covid-19 cases").length === 0, "P4 leading unary minus kept; hyphenated words ignored", vals("what is -5+3?"));
    check(JSON.stringify(vals("what is 2(3+4)?")) === '["2*(3+4)"]', "P5 implicit multiplication made explicit", vals("what is 2(3+4)?"));
    check(JSON.stringify(vals("what is 17 × (3 + 4)?")) === '["17*(3+4)"]', "P6 typographic operators and spacing normalised", vals("what is 17 × (3 + 4)?"));
    const d = argumentDomainsFor(reg, "What is (17+25)*2?");
    check(checkArguments(d, "math.evaluate", { expression: "( 17 + 25 ) * 2" }) === null, "P7 equivalent up to whitespace → accepted");
    check(checkArguments(d, "math.evaluate", { expression: "17+25*2" }) !== null, "P8 precedence change (17+25*2) → rejected");
    check(checkArguments(d, "math.evaluate", { expression: "42*2" }) !== null, "P9 value-equal rewrite (42*2) → rejected: only the requested expression is executed");
    check(checkArguments(d, "math.evaluate", { expression: "(17+25)*2" }) === null && groundCall(reg, "math.evaluate", { expression: "(17+25)*2" }, "What is (17+25)*2?").status === "grounded", "P10 the exact expression passes both the argument check and grounding");
    const s = buildPlanSchema(reg.listUsable(DEFAULT_GRANTS), 8, d) as any;
    const mv = s.properties.steps.items.anyOf.find((v: any) => v.properties.tool.const === "math.evaluate");
    check(JSON.stringify(mv.properties.input.properties.expression.enum) === '["(17+25)*2"]', "P11 the output schema restricts the expression to the requested one");
    check(vals("How many hours are in a week?").length === 0, "P12 no written arithmetic → unconstrained (and the step stays ungrounded → at most unverified)");
    const ok = await run(new Scripted([plan([{ id: "s1", tool: "math.evaluate", input: { expression: "(17+25)*2" } }])], [SAT]), "What is (17+25)*2?");
    check(ok.outcome === "completed" && ok.steps[0].outcome?.evidence === "(17+25)*2 = 84", "P13 '(17+25)*2' → 84, completed", ok.steps[0]?.outcome?.evidence);
  }

  // ── W. Whole-request explanation (v2 benchmark defect: u04 completed on its "today" part) ──
  console.log("\n[W] The whole request must be explained, not just its recognised part");
  {
    const u04 = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "Search the web for today's weather forecast");
    check(u04.outcome === "unverified" && ["search", "web", "weather", "forecast"].every((w) => u04.verification!.unexplained.includes(w)),
      "W1 regression: 'search the web for today's weather' + a successful time lookup → unverified (search/web/weather/forecast unexplained)", { outcome: u04.outcome, u: u04.verification?.unexplained });
    const u03 = await run(new Scripted([plan([{ id: "s1", tool: "workspace.list_dir", input: { path: "docs" } }])], [SAT]), "Delete the docs folder");
    check(u03.outcome === "unverified" && u03.verification!.unexplained.includes("delete"), "W2 'Delete the docs folder' served by a listing → unverified (delete is unexplained)", { outcome: u03.outcome, u: u03.verification?.unexplained });
    const ok = await run(new Scripted([plan([{ id: "s1", tool: "system.info", input: {} }])], [SAT]), "How much RAM does this computer have?");
    check(ok.outcome === "completed" && ok.verification!.unexplained.length === 0, "W3 a fully explained request still completes", { outcome: ok.outcome, u: ok.verification?.unexplained });
    const extra = await run(new Scripted([plan([{ id: "s1", tool: "system.time", input: {} }])], [SAT]), "What time is it and remind me to call mum");
    check(extra.outcome === "unverified" && extra.verification!.unexplained.includes("remind"), "W4 a request with an extra, unsupported clause → unverified", { outcome: extra.outcome, u: extra.verification?.unexplained });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
