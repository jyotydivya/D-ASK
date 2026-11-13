/**
 * D-ASK 2.0 Milestone 1 — Agent runtime tests.
 * Run with: npx tsx tests/agent-runtime/agent-runtime.test.ts
 *
 * Uses a scripted LanguageModel (no network, deterministic). Everything else is
 * real: schema validator, ToolRegistry, built-in tools, Planner, Verifier,
 * AgentRuntime, and the bridge into taskService/eventService used by /api/tasks.
 *
 * Parts:
 *   A. schema validator          E. runtime end-to-end (plan → tools → observe → verify)
 *   B. built-in tools            F. bridge: task model + event stream + cancellation
 *   C. tool registry             G. UI event reduction (useTask.applyNodeEvent)
 *   D. planner                   H. /api/tasks engine selection (auth preserved)
 */
import path from "node:path";
import { validate } from "../../agent/runtime/schema";
import { ToolRegistry, DENY_ALL_APPROVALS } from "../../agent/runtime/toolRegistry";
import { evaluateArithmetic, mathEvaluateTool, systemInfoTool, systemTimeTool, createWorkspaceListDirTool } from "../../agent/runtime/tools/builtin";
import { Brain } from "../../agent/runtime/brain";
import { Planner } from "../../agent/runtime/planner";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS, runRuntimeTask, cancelRuntimeTask, resetRuntimeBridgeForTests } from "../../agent/runtime";
import type { LanguageModel, StructuredRequest, ToolPermission, ToolSpec, RuntimeEvent } from "../../agent/runtime/types";
import { taskService } from "../../services/taskService";
import { eventService } from "../../services/eventService";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Test doubles ─────────────────────────────────────────────────────────────

type Scripted = unknown | Error | ((req: StructuredRequest) => unknown | Promise<unknown>);

class ScriptedModel implements LanguageModel {
  readonly name = "scripted";
  calls: StructuredRequest[] = [];
  constructor(private plans: Scripted[], private assessments: Scripted[] = []) {}
  async generateJson(req: StructuredRequest): Promise<unknown> {
    this.calls.push(req);
    const queue = req.purpose === "plan" ? this.plans : this.assessments;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error(`no scripted ${req.purpose} response`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? await (next as (r: StructuredRequest) => unknown)(req) : structuredClone(next);
  }
  count(purpose: "plan" | "assess") { return this.calls.filter((c) => c.purpose === purpose).length; }
}

const satisfied = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "evidence shows all criteria" };

function slowTool(name: string, opts: { timeoutMs?: number; holdMs?: number; perms?: ToolPermission[]; approval?: boolean } = {}) {
  const seen = { aborted: false, started: 0 };
  const spec: ToolSpec<Record<string, never>, { done: true }> = {
    name, description: "test tool that waits", inputSchema: { type: "object", properties: {} },
    permissions: opts.perms ?? ["compute"], risk: "low", requiresApproval: opts.approval ?? false,
    timeoutMs: opts.timeoutMs ?? 5_000,
    async execute(_i, ctx) {
      seen.started++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, opts.holdMs ?? 60_000);
        ctx.signal.addEventListener("abort", () => { seen.aborted = true; clearTimeout(t); resolve(); }, { once: true });
      });
      return ctx.signal.aborted ? { ok: false, error: "aborted", evidence: "" } : { ok: true, output: { done: true }, evidence: `${name} finished` };
    },
  };
  return { spec, seen };
}

function step(id: string, tool: string, input: Record<string, unknown> = {}, dependsOn: string[] = []) {
  return { id, description: `step ${id}`, tool, input, dependsOn };
}
function plan(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { intent: "task", goal: "test goal", successCriteria: ["criterion"], steps, ...extra };
}
function newRuntime(model: LanguageModel, extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  return new AgentRuntime({ model, registry: extra.registry ?? createDefaultRegistry(ROOT), granted: extra.granted ?? DEFAULT_GRANTS, ...extra });
}
function collect(): { events: RuntimeEvent[]; sink: { emit(e: RuntimeEvent): void } } {
  const events: RuntimeEvent[] = [];
  return { events, sink: { emit: (e) => events.push(e) } };
}

async function main() {
  // ── A. schema ──────────────────────────────────────────────────────────────
  console.log("\n[A] schema validator");
  {
    const s = { type: "object" as const, properties: { n: { type: "integer" as const, minimum: 1, maximum: 5 }, m: { type: "string" as const, enum: ["a", "b"] } }, required: ["n"] };
    check(validate(s, { n: 3, m: "a" }).ok, "valid object accepted");
    check(!validate(s, {}).ok, "missing required rejected");
    check(!validate(s, { n: 3, extra: 1 }).ok, "unknown property rejected by default");
    check(!validate(s, { n: 2.5 }).ok, "non-integer rejected");
    check(!validate(s, { n: 9 }).ok, "above maximum rejected");
    check(!validate(s, { n: 1, m: "z" }).ok, "enum violation rejected");
    check(!validate(s, { n: Number.NaN }).ok, "NaN rejected");
    check(!validate(s, null).ok && !validate(s, [1]).ok, "null/array where object expected rejected");
  }

  // ── B. built-in tools ──────────────────────────────────────────────────────
  console.log("\n[B] built-in tools");
  {
    const cases: [string, number][] = [["2+3*4", 14], ["(1+2)*3", 9], ["-2^2", -4], ["2^-1", 0.5], ["2^3^2", 512], ["10 % 4", 2], ["1.5e3 / 3", 500], ["--3", 3]];
    for (const [e, v] of cases) check(evaluateArithmetic(e) === v, `arithmetic ${e} = ${v}`, evaluateArithmetic(e));
    for (const bad of ["process.exit()", "1/0", "2+", "(1", "constructor", "1;2", "a=1", "Math.PI", "1 2"]) {
      let threw = false; try { evaluateArithmetic(bad); } catch { threw = true; }
      check(threw, `arithmetic rejects ${JSON.stringify(bad)}`);
    }
    let deep = false; try { evaluateArithmetic("(".repeat(40) + "1" + ")".repeat(40)); } catch { deep = true; }
    check(deep, "arithmetic rejects excessive nesting");

    const ctx = { signal: new AbortController().signal, taskId: "t", stepId: "s" };
    const t = await systemTimeTool.execute({}, ctx);
    check(t.ok && !!t.output && !Number.isNaN(Date.parse(t.output.iso)) && t.evidence.length > 0, "system.time returns a timestamp with evidence");
    const tz = await systemTimeTool.execute({ timeZone: "UTC" }, ctx);
    check(tz.ok && tz.output?.timeZone === "UTC", "system.time honours an explicit time zone");
    const info = await systemInfoTool.execute({}, ctx);
    check(info.ok && (info.output?.totalMemBytes ?? 0) > 0 && (info.output?.cpuCount ?? 0) > 0, "system.info returns plausible figures");
    check(!/hostname|user/i.test(JSON.stringify(Object.keys(info.output ?? {}))), "system.info exposes no host/user identifiers");

    const ls = createWorkspaceListDirTool(ROOT);
    const root = await ls.execute({}, ctx);
    const names = (root.output?.entries ?? []).map((e) => e.name);
    check(root.ok && names.includes("package.json") && names.includes("agent"), "workspace.list_dir lists the workspace root");
    check(!names.some((n) => /^\.env/i.test(n)), "workspace.list_dir hides .env* files", names.filter((n) => n.startsWith(".")));
    check(!names.includes("node_modules") && !names.includes(".git"), "workspace.list_dir hides node_modules and .git");
    const sub = await ls.execute({ path: "agent/runtime" }, ctx);
    check(sub.ok && (sub.output?.entries ?? []).some((e) => e.name === "runtime.ts"), "workspace.list_dir lists a subfolder");
    for (const p of ["..", "../..", "agent/../../", "C:/Windows", "/etc", "\\\\server\\share", ".git", "node_modules", ".env.local", "agent/../.env.local"]) {
      const r = await ls.execute({ path: p }, ctx);
      check(!r.ok, `workspace.list_dir refuses ${JSON.stringify(p)}`, r);
    }

    // Link escape: a junction/symlink inside the root that points outside it must not be listable.
    const fsp = (await import("node:fs")).promises;
    const os = await import("node:os");
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "dask-ls-"));
    try {
      const inner = path.join(sandbox, "root");
      const outside = path.join(sandbox, "outside");
      await fsp.mkdir(inner);
      await fsp.mkdir(outside);
      await fsp.writeFile(path.join(outside, "secret.txt"), "x");
      await fsp.symlink(outside, path.join(inner, "escape"), "junction");
      const jailed = createWorkspaceListDirTool(inner);
      const esc = await jailed.execute({ path: "escape" }, ctx);
      check(!esc.ok && /outside the workspace/.test(esc.error ?? ""), "workspace.list_dir refuses a junction that escapes the root", esc);
      const rootList = await jailed.execute({}, ctx);
      check(rootList.ok && rootList.output!.entries.some((e) => e.name === "escape"), "workspace.list_dir still shows the link's name (contents not followed)");
    } finally {
      await fsp.rm(sandbox, { recursive: true, force: true });
    }
  }

  // ── C. registry ────────────────────────────────────────────────────────────
  console.log("\n[C] tool registry");
  {
    const reg = createDefaultRegistry(ROOT);
    const base = { taskId: "t", stepId: "s", signal: new AbortController().signal, granted: DEFAULT_GRANTS, approvalGate: DENY_ALL_APPROVALS };
    // Phase 7A added the four read-only filesystem tools to the exact allowlist.
    check(reg.list().map((t) => t.name).sort().join(",") === "filesystem.find_text,filesystem.metadata,filesystem.plan_organize,filesystem.read,filesystem.search,filesystem.summarize,math.evaluate,system.info,system.time,workspace.list_dir", "default registry exposes exactly the 10 safe tools (read-only; summarize and plan_organize added 2026-11-10)");
    check(!reg.list().some((t) => t.permissions.some((p) => ["process:spawn", "desktop:actuate", "network", "write:workspace"].includes(p))), "no default tool needs spawn/actuate/network/write");
    check((await reg.invoke("shell.run", {}, base)).status === "unknown_tool", "unknown tool refused");
    check((await reg.invoke("math.evaluate", {}, base)).status === "invalid_input", "missing required input refused");
    check((await reg.invoke("math.evaluate", { expression: "1+1", extra: true }, base)).status === "invalid_input", "unknown input property refused");
    const ok = await reg.invoke("math.evaluate", { expression: "6*7" }, base);
    check(ok.status === "executed" && ok.outcome.ok && (ok.outcome.output as { value: number }).value === 42, "valid call executes");

    let threw = false; try { reg.register(mathEvaluateTool); } catch { threw = true; }
    check(threw, "duplicate registration rejected");
    threw = false; try { new ToolRegistry().register({ ...mathEvaluateTool, name: "Bad Name" }); } catch { threw = true; }
    check(threw, "invalid tool name rejected");

    const extra = new ToolRegistry();
    const net = slowTool("test.net", { perms: ["network"], holdMs: 1 });
    extra.register(net.spec);
    check((await extra.invoke("test.net", {}, base)).status === "permission_denied" && net.seen.started === 0, "tool needing an ungranted permission is refused before execution");

    const gated = slowTool("test.gated", { approval: true, holdMs: 1 });
    extra.register(gated.spec);
    const denied = await extra.invoke("test.gated", {}, base);
    check(denied.status === "approval_denied" && gated.seen.started === 0, "approval-required tool refused by the default gate, never executed");
    const approved = await extra.invoke("test.gated", {}, { ...base, approvalGate: { request: async () => ({ approved: true, reason: "test" }) } });
    check(approved.status === "executed" && gated.seen.started === 1, "approval-required tool runs only when the gate approves");
    const throwingGate = await extra.invoke("test.gated", {}, { ...base, approvalGate: { request: async () => { throw new Error("boom"); } } });
    check(throwingGate.status === "approval_denied", "a failing approval gate denies (fail closed)");
    const truthy = await extra.invoke("test.gated", {}, { ...base, approvalGate: { request: async () => ({ approved: "yes" as unknown as boolean, reason: "x" }) } });
    check(truthy.status === "approval_denied", "only approved === true counts as approval");

    const hang = slowTool("test.hang", { timeoutMs: 80 });
    extra.register(hang.spec);
    const t0 = Date.now();
    const to = await extra.invoke("test.hang", {}, base);
    check(to.status === "timeout" && Date.now() - t0 < 1_000, "hung tool times out at its declared limit", to.status);
    await sleep(10);
    check(hang.seen.aborted, "timed-out tool's signal is aborted");

    const cancel = slowTool("test.cancel");
    extra.register(cancel.spec);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const c = await extra.invoke("test.cancel", {}, { ...base, signal: ac.signal });
    check(c.status === "cancelled" && cancel.seen.aborted, "caller cancellation aborts a running tool");

    extra.register({ ...mathEvaluateTool, name: "test.malformed", execute: async () => ({ nope: 1 } as never) });
    check((await extra.invoke("test.malformed", { expression: "1" }, base)).status === "error", "malformed tool result treated as error");
    extra.register({ ...mathEvaluateTool, name: "test.throws", execute: async () => { throw new Error("kaboom"); } });
    const th = await extra.invoke("test.throws", { expression: "1" }, base);
    check(th.status === "error" && th.outcome.error === "kaboom", "tool exception captured as error");
  }

  // ── D. planner ─────────────────────────────────────────────────────────────
  console.log("\n[D] planner");
  {
    const reg = createDefaultRegistry(ROOT);
    const planner = new Planner(new Brain(new ScriptedModel([]), 1_000), reg);
    const opts = { maxSteps: 3, granted: DEFAULT_GRANTS };
    const good = planner.check(plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "1+1" }, ["s1"])]), opts);
    check(good.ok, "valid plan accepted");
    const bad = (p: unknown, label: string) => {
      const r = planner.check(p, opts);
      check(!r.ok, label, r.ok ? undefined : r.errors);
    };
    bad(plan([step("s1", "shell.exec", { cmd: "dir" })]), "plan with unknown tool rejected");
    bad(plan([step("s1", "math.evaluate", {})]), "plan with invalid tool input rejected");
    bad(plan([step("s1", "system.time", {}, ["s2"]), step("s2", "system.info")]), "forward dependency rejected (no cycles possible)");
    bad(plan([step("s1", "system.time"), step("s1", "system.info")]), "duplicate step id rejected");
    bad(plan([step("a", "system.time"), step("b", "system.time"), step("c", "system.time"), step("d", "system.time")]), "plan over the step limit rejected");
    bad(plan([]), "task with no steps rejected");
    bad({ intent: "task", steps: "nope" }, "malformed proposal rejected");
    bad(plan([step("s 1", "system.time")]), "unsafe step id rejected");
    const noNet = planner.check(plan([step("s1", "system.time")]), { maxSteps: 3, granted: new Set<ToolPermission>(["compute"]) });
    check(!noNet.ok, "tool outside the granted permissions rejected at plan time");
    const unsupported = planner.check({ intent: "unsupported", goal: "send email", refusalReason: "no email tool", steps: [] }, opts);
    check(unsupported.ok && unsupported.plan.intent === "unsupported" && unsupported.plan.steps.length === 0, "unsupported intent becomes a refusal plan");

    const repairModel = new ScriptedModel([plan([step("s1", "math.evaluate", {})]), plan([step("s1", "math.evaluate", { expression: "2+2" })])]);
    const repaired = await new Planner(new Brain(repairModel, 1_000), reg).createPlan({ objective: "x", history: [], maxSteps: 3, granted: DEFAULT_GRANTS, signal: new AbortController().signal });
    check(repaired.ok && repaired.attempts === 2, "one repair round recovers an invalid plan");
    check(/Your previous plan was rejected/.test(repairModel.calls[1]?.user ?? ""), "repair prompt carries the validation errors back to the model");
    const neverValid = await new Planner(new Brain(new ScriptedModel([plan([step("s1", "nope.tool")])]), 1_000), reg)
      .createPlan({ objective: "x", history: [], maxSteps: 3, granted: DEFAULT_GRANTS, signal: new AbortController().signal });
    check(!neverValid.ok && neverValid.attempts === 2, "planning gives up after the repair round");
    check(/<user_request>\nx\n<\/user_request>/.test(repairModel.calls[0]?.user ?? ""), "objective is fenced as data in the prompt");
  }

  // ── E. runtime end-to-end ──────────────────────────────────────────────────
  console.log("\n[E] runtime end-to-end");
  {
    // E1 happy path: plan → 3 tools → observe → verify → completed
    const m1 = new ScriptedModel([plan([
      step("s1", "system.time"), step("s2", "math.evaluate", { expression: "365*24" }), step("s3", "system.info"),
    ], { successCriteria: ["current time shown", "hours per year computed", "memory reported"] })], [satisfied]);
    const c1 = collect();
    // Phase 4 fail-closed rule: "completed" needs deterministic grounding, so the request
    // states the arithmetic explicitly (365*24) instead of "hours in a year".
    const r1 = await newRuntime(m1).run({ taskId: "e1", objective: "What time is it, what is 365*24, and how much RAM do I have?", sink: c1.sink });
    check(r1.outcome === "completed", "E1 all steps succeed + grounded + criteria confirmed → completed", r1.outcome);
    check(r1.verification?.independentlyVerified === true && r1.verification.facets.length === 3, "E1 three request facets detected and covered deterministically", r1.verification?.facets);
    const r1u = await newRuntime(new ScriptedModel([plan([
      step("s1", "system.time"), step("s2", "math.evaluate", { expression: "365*24" }), step("s3", "system.info"),
    ])], [satisfied])).run({ taskId: "e1u", objective: "What time is it, how many hours in a year, and how much RAM do I have?" });
    check(r1u.outcome === "unverified", "E1u model says satisfied, but 365*24 is not in the request text → unverified (model alone cannot complete)", r1u.outcome);
    check(r1.steps.length === 3 && r1.steps.every((s) => s.status === "succeeded"), "E1 three tool steps succeeded");
    check(r1.toolCalls === 3 && r1.iterations === 1, "E1 three tool calls, one iteration");
    check(r1.response.includes("365*24 = 8760") && /logical CPUs/.test(r1.response), "E1 response is built from tool evidence", r1.response);
    check(r1.verification?.method === "evidence+model" && r1.verification.criteriaSatisfied === true, "E1 verification used evidence + model");
    const order = c1.events.map((e) => e.type).join(",");
    check(order.startsWith("phase,phase,plan,phase,step.started,step.finished,step.started,step.finished,step.started,step.finished,phase,verification,finished"), "E1 event order: understand, plan, execute×3, verify, finish", order);
    check(/8760/.test(m1.calls.find((c) => c.purpose === "assess")?.user ?? ""), "E1 verifier is shown the actual tool evidence");

    // E2 model claims success but a step failed → partial (model cannot upgrade)
    const r2 = await newRuntime(new ScriptedModel([plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "1/0" })])], [satisfied]))
      .run({ taskId: "e2", objective: "time and 1/0" });
    check(r2.outcome === "partial" && r2.steps[1]!.status === "failed", "E2 failed step + model 'satisfied' → partial, never completed", r2.outcome);
    check(/Partially done: 1 of 2/.test(r2.response) && /Division by zero/.test(r2.response), "E2 response reports the failure honestly", r2.response);

    // E3 assessment unavailable → unverified, not completed
    const r3 = await newRuntime(new ScriptedModel([plan([step("s1", "system.time")])], [new Error("provider down")])).run({ taskId: "e3", objective: "time" });
    check(r3.outcome === "unverified" && r3.verification?.method === "evidence-only", "E3 model check unavailable → unverified", r3.outcome);
    const r3b = await newRuntime(new ScriptedModel([plan([step("s1", "system.time")])], [{ looksGood: "yes" }])).run({ taskId: "e3b", objective: "time" });
    check(r3b.outcome === "unverified", "E3b malformed assessment → unverified", r3b.outcome);
    const r3c = await newRuntime(new ScriptedModel([plan([step("s1", "system.time")])], [{ criteriaSatisfied: false, missing: ["date in Tokyo"], needsMoreSteps: false }])).run({ taskId: "e3c", objective: "time" });
    check(r3c.outcome === "partial" && /Not confirmed: date in Tokyo/.test(r3c.response), "E3c criteria not met → partial with the gap stated", r3c.response);

    // E4 verifier asks for more → bounded second round → completed
    const m4 = new ScriptedModel(
      [plan([step("s1", "system.time")]), plan([step("s1", "math.evaluate", { expression: "2+2" })])],
      [{ criteriaSatisfied: false, missing: ["sum"], needsMoreSteps: true }, satisfied],
    );
    const c4 = collect();
    const r4 = await newRuntime(m4).run({ taskId: "e4", objective: "time then 2+2", sink: c4.sink });
    check(r4.outcome === "completed" && r4.iterations === 2 && r4.steps.length === 2, "E4 follow-up round closes the gap → completed in 2 iterations", r4);
    check(r4.steps[1]!.step.id === "r2_s1", "E4 follow-up step ids are namespaced (no collisions)");
    check(/<observations>[\s\S]*Current time/.test(m4.calls.filter((c) => c.purpose === "plan")[1]?.user ?? ""), "E4 follow-up planning is given the observed evidence");
    check(c4.events.some((e) => e.type === "phase" && e.phase === "replanning"), "E4 emits a replanning phase");

    // E5 loop bound: model always wants more steps
    const m5 = new ScriptedModel([plan([step("s1", "system.time")])], [{ criteriaSatisfied: false, missing: ["more"], needsMoreSteps: true }]);
    const r5 = await newRuntime(m5, { limits: { maxIterations: 3 } }).run({ taskId: "e5", objective: "loop" });
    check(r5.iterations === 3 && m5.count("plan") === 3 && r5.toolCalls === 3, "E5 a model that always asks for more is stopped at maxIterations", { it: r5.iterations, plans: m5.count("plan") });
    check(r5.outcome === "partial", "E5 unbounded request ends as partial, not completed", r5.outcome);
    const r5b = await newRuntime(new ScriptedModel([plan([step("a", "system.time"), step("b", "system.time"), step("c", "system.time")])], [{ criteriaSatisfied: false, needsMoreSteps: true }]), { limits: { maxToolCalls: 4, maxIterations: 5 } })
      .run({ taskId: "e5b", objective: "budget" });
    check(r5b.toolCalls === 4 && r5b.steps.filter((s) => s.status === "skipped").length === 2, "E5b tool-call budget caps execution; excess steps are skipped", { calls: r5b.toolCalls, it: r5b.iterations });

    // E6 dependency failure → dependent skipped
    const r6 = await newRuntime(new ScriptedModel([plan([step("s1", "math.evaluate", { expression: "1/0" }), step("s2", "system.time", {}, ["s1"]), step("s3", "system.info")])], [satisfied]))
      .run({ taskId: "e6", objective: "deps" });
    // Dependencies are runtime-generated and strictly sequential: a failed step stops every later step.
    check(r6.steps.map((s) => s.status).join(",") === "failed,skipped,skipped" && r6.outcome === "failed", "E6 sequential (runtime-generated) dependencies: a failed step stops the steps after it", r6.steps.map((s) => s.status));
    check(JSON.stringify(r6.steps.map((s) => s.step.dependsOn)) === '[[],["s1"],["s2"]]', "E6 dependsOn is generated deterministically (each step after the previous)", r6.steps.map((s) => s.step.dependsOn));

    // E7 cancellation during a slow tool
    const reg7 = createDefaultRegistry(ROOT);
    const slow7 = slowTool("test.slow");
    reg7.register(slow7.spec);
    const m7 = new ScriptedModel([plan([step("s1", "system.time"), step("s2", "test.slow"), step("s3", "system.info")])], [satisfied]);
    const ac7 = new AbortController();
    const p7 = newRuntime(m7, { registry: reg7 }).run({ taskId: "e7", objective: "slow", signal: ac7.signal });
    await sleep(80); ac7.abort();
    const t7 = Date.now();
    const r7 = await p7;
    check(r7.outcome === "cancelled" && Date.now() - t7 < 1_000, "E7 cancellation stops a running task promptly", r7.outcome);
    check(r7.steps.map((s) => s.status).join(",") === "succeeded,cancelled,cancelled" && slow7.seen.aborted, "E7 in-flight tool aborted; later steps never run");
    const finishedIds = new Set<string>();
    const c7 = collect();
    const ac7b = new AbortController();
    const reg7b = createDefaultRegistry(ROOT);
    reg7b.register(slowTool("test.slow").spec);
    const p7b = newRuntime(new ScriptedModel([plan([step("s1", "test.slow"), step("s2", "system.time"), step("s3", "system.info")])], [satisfied]), { registry: reg7b })
      .run({ taskId: "e7b", objective: "slow", signal: ac7b.signal, sink: c7.sink });
    await sleep(60); ac7b.abort(); await p7b;
    for (const e of c7.events) if (e.type === "step.finished") finishedIds.add(e.stepId);
    check(["s1", "s2", "s3"].every((id) => finishedIds.has(id)), "E7b every step, including never-started ones, gets a terminal step event", [...finishedIds]);
    check(m7.count("assess") === 0, "E7 no verification model call after cancellation");
    check(/Cancelled after 1 of 3/.test(r7.response), "E7 response says what was done before cancelling", r7.response);

    // E8 run time limit
    const reg8 = createDefaultRegistry(ROOT);
    reg8.register(slowTool("test.slow").spec);
    const r8 = await newRuntime(new ScriptedModel([plan([step("s1", "system.time"), step("s2", "test.slow"), step("s3", "system.info")])], [satisfied]), { registry: reg8, limits: { runTimeoutMs: 150 } })
      .run({ taskId: "e8", objective: "deadline" });
    check(r8.outcome === "partial" && /time limit/.test(r8.error ?? ""), "E8 run time limit ends the run with what was achieved", { outcome: r8.outcome, error: r8.error });

    // E9 unsupported → refused, no tools
    const c9 = collect();
    const r9 = await newRuntime(new ScriptedModel([{ intent: "unsupported", goal: "email boss", refusalReason: "There is no email tool.", steps: [] }]))
      .run({ taskId: "e9", objective: "email my boss", sink: c9.sink });
    check(r9.outcome === "refused" && r9.toolCalls === 0 && /no email tool/.test(r9.response), "E9 unsupported request is refused, nothing executed", r9.response);

    // E10 planning failure → failed, nothing executed
    const r10 = await newRuntime(new ScriptedModel([new Error("all providers failed")])).run({ taskId: "e10", objective: "x" });
    check(r10.outcome === "failed" && r10.toolCalls === 0 && /Planning failed/.test(r10.response), "E10 planning failure → failed with the reason", r10.response);
    const r10b = await newRuntime(new ScriptedModel([() => new Promise(() => {})]), { limits: { modelTimeoutMs: 100 } }).run({ taskId: "e10b", objective: "x" });
    check(r10b.outcome === "failed" && /timed out/.test(r10b.response), "E10b a hung model call is bounded by the model timeout", r10b.response);

    // E11 approval-required tool in a plan is refused at execution (default gate)
    const reg11 = createDefaultRegistry(ROOT);
    const g11 = slowTool("test.sensitive", { approval: true, holdMs: 1 });
    reg11.register(g11.spec);
    const c11 = collect();
    const r11 = await newRuntime(new ScriptedModel([plan([step("s1", "test.sensitive"), step("s2", "system.time")])], [satisfied]), { registry: reg11 })
      .run({ taskId: "e11", objective: "sensitive", sink: c11.sink });
    check(g11.seen.started === 0 && r11.steps[0]!.status === "failed" && r11.steps[1]!.status === "skipped" && r11.outcome === "failed", "E11 approval-required step never runs without approval (later steps stop)", r11.steps.map((s) => s.status));
    check(c11.events.some((e) => e.type === "approval.denied"), "E11 approval denial is reported as an event");

    // E12 a tool whose own postcondition fails is a failed step
    const reg12 = createDefaultRegistry(ROOT);
    reg12.register({ ...systemTimeTool, name: "test.liar", execute: async () => ({ ok: true, output: { iso: "not-a-date", local: "", timeZone: "", epochMs: 0 }, evidence: "it is noon" }) });
    reg12.register({ ...systemTimeTool, name: "test.silent", execute: async () => ({ ok: true, output: { iso: new Date().toISOString(), local: "", timeZone: "", epochMs: 0 }, evidence: "  " }) });
    // Separate runs: with sequential dependencies a second step would be skipped after the first fails.
    const r12 = await newRuntime(new ScriptedModel([plan([step("s1", "test.liar")])], [satisfied]), { registry: reg12 })
      .run({ taskId: "e12", objective: "x" });
    const r12b = await newRuntime(new ScriptedModel([plan([step("s1", "test.silent")])], [satisfied]), { registry: reg12 })
      .run({ taskId: "e12b", objective: "x" });
    check(r12.steps[0]!.status === "failed" && /Postcondition/.test(r12.steps[0]!.error ?? ""), "E12 'ok' with invalid output fails the step's postcondition");
    check(r12b.steps[0]!.status === "failed" && /no evidence/.test(r12b.steps[0]!.error ?? ""), "E12 'ok' with no evidence is not counted as success");
    check(r12.outcome === "failed" && r12b.outcome === "failed", "E12 no real evidence → failed despite model 'satisfied'", [r12.outcome, r12b.outcome]);

    // E13 a throwing event sink cannot break a run
    const r13 = await newRuntime(new ScriptedModel([plan([step("s1", "system.time")])], [satisfied]))
      .run({ taskId: "e13", objective: "What time is it?", sink: { emit() { throw new Error("ui gone"); } } });
    check(r13.outcome === "completed", "E13 a failing event sink does not affect the run");
  }

  // ── F. bridge into taskService / eventService ──────────────────────────────
  console.log("\n[F] bridge: task model + event stream");
  {
    resetRuntimeBridgeForTests();
    const model = new ScriptedModel([plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "12*12" })])], [satisfied]);
    const task = taskService.createTask("time and 12*12", "sess_bridge");
    const report = await runRuntimeTask(task.id, { runtime: newRuntime(model) });
    const after = taskService.getTask(task.id)!;
    const types = eventService.getHistory(task.id, 200).map((e) => e.type);
    check(report?.outcome === "completed" && after.status === "completed", "F1 task reaches completed in the task service", after.status);
    check(after.finalResponse?.includes("12*12 = 144") === true, "F1 final response stored on the task");
    for (const t of ["task.planned", "task.started", "node.started", "tool.started", "tool.completed", "node.completed", "verification.started", "verification.completed", "task.completed"]) {
      check(types.includes(t as never), `F1 publishes ${t}`);
    }
    const planned = eventService.getHistory(task.id, 200).find((e) => e.type === "task.planned")!;
    check(Array.isArray(planned.payload.steps) && (planned.payload.steps as unknown[]).length === 2 && planned.payload.engine === "runtime", "F1 task.planned carries the structured plan");
    const done = eventService.getHistory(task.id, 200).find((e) => e.type === "task.completed")!;
    check(done.payload.outcome === "completed" && done.payload.stepsSucceeded === 2, "F1 task.completed carries the verified outcome");
    const nodes = taskService.getNodes(task.id);
    check(nodes.length === 2 && nodes.every((n) => n.status === "completed" && n.agentType === "tool"), "F1 plan steps are visible as task nodes", nodes.map((n) => n.status));
    check(taskService.getBlackboard(task.id)!.findings.length === 2, "F1 evidence recorded as findings");

    // conversation context carried to the next task in the same session
    const model2 = new ScriptedModel([plan([step("s1", "system.time")])], [satisfied]);
    const task2 = taskService.createTask("and again", "sess_bridge");
    await runRuntimeTask(task2.id, { runtime: newRuntime(model2) });
    check(/<history>[\s\S]*time and 12\*12/.test(model2.calls[0]?.user ?? ""), "F2 previous turn in the same session is given to the planner as context");
    const model3 = new ScriptedModel([plan([step("s1", "system.time")])], [satisfied]);
    await runRuntimeTask(taskService.createTask("other", "sess_other").id, { runtime: newRuntime(model3) });
    check(!/<history>/.test(model3.calls[0]?.user ?? ""), "F2 other sessions get no foreign history");

    // partial outcome is reported as such
    const taskP = taskService.createTask("partial", "s");
    await runRuntimeTask(taskP.id, { runtime: newRuntime(new ScriptedModel([plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "1/0" })])], [satisfied])) });
    const pDone = eventService.getHistory(taskP.id, 200).find((e) => e.type === "task.completed");
    check(pDone?.payload.outcome === "partial", "F3 partial result is published with outcome 'partial'", pDone?.payload.outcome);
    check(eventService.getHistory(taskP.id, 200).some((e) => e.type === "tool.failed" && e.payload.tool === "math.evaluate"), "F3 failed tool call published as tool.failed");

    // failed planning → task.failed
    const taskF = taskService.createTask("fail", "s");
    await runRuntimeTask(taskF.id, { runtime: newRuntime(new ScriptedModel([new Error("no provider")])) });
    check(taskService.getTask(taskF.id)!.status === "failed" && eventService.getHistory(taskF.id, 200).some((e) => e.type === "task.failed"), "F4 planning failure → task failed + task.failed");

    // cancellation via the registry used by DELETE /api/tasks/[id]
    const reg = createDefaultRegistry(ROOT);
    const slow = slowTool("test.slow");
    reg.register(slow.spec);
    const taskC = taskService.createTask("cancel me", "s");
    const pending = runRuntimeTask(taskC.id, { runtime: newRuntime(new ScriptedModel([plan([step("s1", "test.slow"), step("s2", "system.time")])], [satisfied]), { registry: reg }) });
    await sleep(80);
    // same sequence as the DELETE handler
    taskService.updateTaskStatus(taskC.id, "cancelled");
    eventService.publish(taskC.id, "task.cancelled", { taskId: taskC.id, reason: "User cancelled" });
    check(cancelRuntimeTask(taskC.id), "F5 cancelRuntimeTask finds the active run");
    const rc = await pending;
    check(rc?.outcome === "cancelled" && slow.seen.aborted, "F5 the in-flight tool is aborted");
    check(taskService.getTask(taskC.id)!.status === "cancelled", "F5 task stays cancelled (never resurrected)");
    check(eventService.getHistory(taskC.id, 200).filter((e) => e.type === "task.cancelled").length === 1, "F5 task.cancelled published exactly once");
    check(!eventService.getHistory(taskC.id, 200).some((e) => e.type === "task.completed" || e.type === "task.failed"), "F5 no completion/failure published after cancel");
    check(!cancelRuntimeTask(taskC.id), "F5 nothing left to cancel afterwards");
    check((await runRuntimeTask("task_does_not_exist")) === null, "F6 unknown task id is ignored");
  }

  // ── G. UI event reduction ──────────────────────────────────────────────────
  console.log("\n[G] UI: useTask.applyNodeEvent / outcomeLabel");
  {
    const { applyNodeEvent, outcomeLabel } = await import("../../hooks/useTask");
    resetRuntimeBridgeForTests();
    const t = taskService.createTask("ui", "s_ui");
    await runRuntimeTask(t.id, { runtime: newRuntime(new ScriptedModel([plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "1/0" }), step("s3", "system.info", {}, ["s2"])])], [satisfied])) });
    let nodes = [] as ReturnType<typeof applyNodeEvent>;
    for (const e of eventService.getHistory(t.id, 200)) nodes = applyNodeEvent(nodes, e, t.id);
    check(nodes.map((n) => n.status).join(",") === "completed,failed,skipped", "G1 UI reconstructs step states from the event stream", nodes.map((n) => n.status));
    check(String((nodes[0]!.result as { evidence?: string }).evidence).startsWith("Current time"), "G1 UI shows the step's evidence");
    check(/Division by zero/.test(nodes[1]!.error ?? "") && /Depends on step s2/.test(nodes[2]!.error ?? ""), "G1 UI shows failure and skip reasons");
    check(outcomeLabel("partial").includes("Partially") && outcomeLabel("unverified").includes("not confirmed") && outcomeLabel("completed").includes("completed"), "G2 outcome labels distinguish partial/unverified/completed");
  }

  // ── H. /api/tasks engine selection (auth unchanged) ────────────────────────
  console.log("\n[H] /api/tasks: engine selection behind existing auth");
  {
    const { randomBytes } = await import("node:crypto");
    const T = randomBytes(32).toString("base64url");
    process.env.DASK_API_TASK_TOKEN = T;
    process.env.DASK_API_APPROVE_TOKEN = randomBytes(32).toString("base64url");
    const { POST } = await import("../../app/api/tasks/route");
    const mk = (body: unknown, auth = true) => new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/json", ...(auth ? { authorization: `Bearer ${T}` } : {}) },
      body: JSON.stringify(body),
    });
    const unauth = await POST(mk({ objective: "x", engine: "runtime" }, false) as never);
    check(unauth.status === 401, "H1 runtime engine still requires the task token", unauth.status);
    const bogus = await POST(mk({ objective: "x", engine: "bogus" }) as never);
    check(bogus.status === 400, "H2 unknown engine rejected with 400 (no task created)", bogus.status);
    const before = taskService.listTasks().length;
    const empty = await POST(mk({ objective: "  ", engine: "runtime" }) as never);
    check(empty.status === 400 && taskService.listTasks().length === before, "H3 empty objective still rejected");

    // H4: full vertical slice through the real route handlers (in-process, scripted model, no network):
    // POST /api/tasks → plan → tools → verify → GET snapshot → SSE event stream.
    const { GET: GET_TASK, DELETE } = await import("../../app/api/tasks/[id]/route");
    const { GET: GET_EVENTS } = await import("../../app/api/tasks/[id]/events/route");
    const bridge = (globalThis as unknown as Record<symbol, { runtime: AgentRuntime | null }>)[Symbol.for("dask.agentRuntime.bridge.v1")]!;
    const authed = (url: string, method = "GET") => new Request(url, { method, headers: { host: "localhost:3000", authorization: `Bearer ${T}` } });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const waitTerminal = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const s = taskService.getTask(id)?.status;
        if (s === "completed" || s === "failed" || s === "cancelled") return s;
        await sleep(20);
      }
      return taskService.getTask(id)?.status;
    };

    resetRuntimeBridgeForTests();
    bridge.runtime = newRuntime(new ScriptedModel(
      [plan([step("s1", "system.time"), step("s2", "math.evaluate", { expression: "(17+25)*2" }), step("s3", "workspace.list_dir", { path: "agent/runtime" })],
        { successCriteria: ["time shown", "84 computed", "runtime folder listed"] })],
      [satisfied]));
    const created = await POST(mk({ objective: "What time is it, what is (17+25)*2, and what is in agent/runtime?", engine: "runtime" }) as never);
    const { taskId } = (await created.json()) as { taskId: string };
    check(created.status === 201 && typeof taskId === "string", "H4 POST /api/tasks (engine runtime) → 201 with a task id", created.status);
    check((await waitTerminal(taskId)) === "completed", "H4 task runs to completion via the route", taskService.getTask(taskId)?.status);

    const snap = await GET_TASK(authed(`http://localhost:3000/api/tasks/${taskId}`) as never, ctx(taskId));
    const body = (await snap.json()) as { task: { finalResponse: string }; nodes: { status: string }[] };
    check(snap.status === 200 && body.nodes.length === 3 && body.nodes.every((n) => n.status === "completed"), "H4 GET /api/tasks/[id] shows the 3 executed plan steps");
    // brain.ts: an entry that stays among the first 15 shown (the listing is cut at 15; agent/runtime gains files over time).
    check(/\(17\+25\)\*2 = 84/.test(body.task.finalResponse) && /brain\.ts/.test(body.task.finalResponse), "H4 final response contains the tools' observed results", body.task.finalResponse);

    const sse = await GET_EVENTS(authed(`http://localhost:3000/api/tasks/${taskId}/events`) as never, ctx(taskId));
    const text = await sse.text(); // terminal task → history replayed, then the stream closes
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { type: string; payload: Record<string, unknown> });
    const seq = frames.map((f) => f.type);
    check(sse.headers.get("content-type") === "text/event-stream", "H4 SSE endpoint streams text/event-stream");
    check(["task.created", "task.planned", "node.started", "tool.completed", "verification.completed", "task.completed"].every((t) => seq.includes(t)), "H4 SSE stream carries plan, step, tool, verification and completion events", seq);
    check(seq.indexOf("task.planned") < seq.indexOf("node.started") && seq.indexOf("verification.completed") < seq.indexOf("task.completed"), "H4 SSE events arrive in execution order");
    check(frames.find((f) => f.type === "task.created")?.payload.engine === "runtime", "H4 task.created records the engine");
    const sseNoAuth = await GET_EVENTS(new Request(`http://localhost:3000/api/tasks/${taskId}/events`, { headers: { host: "localhost:3000" } }) as never, ctx(taskId));
    check(sseNoAuth.status === 401, "H4 event stream still requires the task token", sseNoAuth.status);

    // H5: DELETE /api/tasks/[id] really stops a runtime task mid-tool.
    const regC = createDefaultRegistry(ROOT);
    const slowC = slowTool("test.slow");
    regC.register(slowC.spec);
    resetRuntimeBridgeForTests();
    bridge.runtime = newRuntime(new ScriptedModel([plan([step("s1", "system.time"), step("s2", "test.slow"), step("s3", "system.info")])], [satisfied]), { registry: regC });
    const createdC = await POST(mk({ objective: "long task", engine: "runtime" }) as never);
    const idC = ((await createdC.json()) as { taskId: string }).taskId;
    for (let i = 0; i < 50 && slowC.seen.started === 0; i++) await sleep(20);
    const del = await DELETE(authed(`http://localhost:3000/api/tasks/${idC}`, "DELETE") as never, ctx(idC));
    check(del.status === 200, "H5 DELETE /api/tasks/[id] accepted", del.status);
    for (let i = 0; i < 50 && !slowC.seen.aborted; i++) await sleep(20);
    await sleep(50);
    const nodesC = taskService.getNodes(idC).map((n) => n.status);
    check(slowC.seen.aborted, "H5 DELETE aborts the in-flight tool call");
    check(taskService.getTask(idC)?.status === "cancelled" && nodesC.join(",") === "completed,skipped,skipped", "H5 task cancelled; unstarted steps never ran", nodesC);
    check(eventService.getHistory(idC, 200).filter((e) => e.type === "task.cancelled").length === 1, "H5 exactly one task.cancelled event");

    // H6: the server default (DASK_AGENT_ENGINE) selects the runtime when the client does not ask.
    resetRuntimeBridgeForTests();
    bridge.runtime = newRuntime(new ScriptedModel([plan([step("s1", "system.time")])], [satisfied]));
    process.env.DASK_AGENT_ENGINE = "runtime";
    const viaEnv = await POST(mk({ objective: "time please" }) as never);
    const idE = ((await viaEnv.json()) as { taskId: string }).taskId;
    await waitTerminal(idE);
    delete process.env.DASK_AGENT_ENGINE;
    check(eventService.getHistory(idE, 200).some((e) => e.type === "task.planned" && e.payload.engine === "runtime"), "H6 DASK_AGENT_ENGINE=runtime routes engine-less requests to the runtime");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
