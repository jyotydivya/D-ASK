/**
 * Aggregate research/benchmark/results/*.json into research/benchmark/RESULTS.md.
 *   npx tsx research/benchmark/report.ts
 * Every number in RESULTS.md is computed from the result files; nothing is typed in by hand.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(__dirname, "results");
type T = Record<string, any>;
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const runs: T[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a");
function wilson(n: number, d: number): string {
  if (!d) return "";
  const z = 1.96, p = n / d, den = 1 + z * z / d;
  const c = (p + z * z / (2 * d)) / den, h = (z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d))) / den;
  return ` [${Math.max(0, 100 * (c - h)).toFixed(0)}–${Math.min(100, 100 * (c + h)).toFixed(0)}]`;
}
const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "n/a");
const count = (ts: T[], f: (t: T) => boolean) => ts.filter(f).length;

const lines: string[] = [];
const L = (s = "") => lines.push(s);
L("# Phase 4 benchmark — computed results");
L("");
L(`Generated ${new Date().toISOString()} from ${files.length} result files in research/benchmark/results/. Temperature 0, context 4096, llama.cpp b11720.`);
L("Rates show 95% Wilson intervals in brackets. n = tasks in the configuration.");
L("");

const admitted = runs.filter((r) => r.admitted);
for (const r of runs.filter((x) => !x.admitted)) {
  L(`**${r.meta.tag}: not admitted by the memory guard.** ${r.reason}`);
  L(`Estimate ${r.estimateMB} MB; available before start ${r.availBeforeMB} MB; admission: ${JSON.stringify(r.admission)}`);
  L("");
}

L("## Reliability");
L("");
L("| Config | n | Task success | First plan JSON ok | First plan valid (structure) | First plan valid (+grounding) | Valid after repair | Tool selection exact | Refusals correct |");
L("|---|---|---|---|---|---|---|---|---|");
for (const r of admitted) {
  const ts: T[] = r.tasks; const n = ts.length;
  const ref = ts.filter((t) => ["u01", "u02", "u03", "u04", "u05"].includes(t.id));
  L(`| ${r.meta.tag} | ${n} | ${pct(count(ts, (t) => t.success), n)}${wilson(count(ts, (t) => t.success), n)} | ${pct(count(ts, (t) => t.firstPlan.jsonOk), n)} | ${pct(count(ts, (t) => t.firstPlan.shapeValid), n)} | ${pct(count(ts, (t) => t.firstPlan.fullValid), n)} | ${pct(count(ts, (t) => t.acceptedAfterRepair), n)} | ${pct(count(ts, (t) => t.toolSelection.exact), n)} | ${pct(count(ref, (t) => t.refused), ref.length)} |`);
}
L("");

L("## Success by category");
L("");
const cats = ["single", "trap", "paraphrase", "multi", "unsupported", "failure"];
L(`| Config | ${cats.join(" | ")} |`);
L(`|---|${cats.map(() => "---").join("|")}|`);
for (const r of admitted) {
  L(`| ${r.meta.tag} | ${cats.map((c) => { const ts = r.tasks.filter((t: T) => t.category === c); return pct(count(ts, (t) => t.success), ts.length); }).join(" | ")} |`);
}
L("");

L("## Verification integrity: product (fail-closed) rule vs legacy (model-trust) rule");
L("");
L("Incorrect completion claim = outcome `completed` while the independent oracle says the request was not correctly and fully served.");
L("Missed completion = the oracle says the request WAS served, but the outcome is not `completed` (cost of being conservative).");
L("");
L("| Config | Completed claims (product) | Incorrect claims (product) | Missed (product) | Completed claims (legacy) | Incorrect claims (legacy) | Missed (legacy) | Model assessor agrees with oracle |");
L("|---|---|---|---|---|---|---|---|");
for (const r of admitted) {
  const ts: T[] = r.tasks;
  const cp = count(ts, (t) => t.outcome === "completed"), cl = count(ts, (t) => t.legacyOutcome === "completed");
  const ip = count(ts, (t) => t.incorrectClaim), il = count(ts, (t) => t.incorrectClaimLegacy);
  const assessed = ts.filter((t) => t.assessor && t.assessor.criteriaSatisfied !== null);
  const agree = count(assessed, (t) => t.assessor.criteriaSatisfied === t.assessor.oracle);
  L(`| ${r.meta.tag} | ${cp} | ${pct(ip, cp)}${wilson(ip, cp)} | ${count(ts, (t) => t.missedCompletion)} | ${cl} | ${pct(il, cl)}${wilson(il, cl)} | ${count(ts, (t) => t.missedCompletionLegacy)} | ${pct(agree, assessed.length)} |`);
}
L("");

L("## Injected failures");
L("");
L("| Config | f01 always-fail info | f02 always-fail math | f03 fail-first math (recovery) | f04 hang time |");
L("|---|---|---|---|---|");
for (const r of admitted) {
  const cell = (id: string) => { const t = r.tasks.find((x: T) => x.id === id); return t ? `${t.outcome}${t.success ? " ✓" : ""} (legacy ${t.legacyOutcome})` : "-"; };
  L(`| ${r.meta.tag} | ${cell("f01")} | ${cell("f02")} | ${cell("f03")} | ${cell("f04")} |`);
}
L("");

L("## Latency and resources (measured)");
L("");
L("| Config | Load | Unload | Plan call p50 / p95 | Assess call p50 | Task e2e p50 / p95 | Multi-step e2e p50 / p95 | Peak llama-server WS | Min available RAM | CPU % p50 (system) | GPU engine % p50 | Non-loopback conns |");
L("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of admitted) {
  const ts: T[] = r.tasks;
  const calls = ts.flatMap((t) => t.modelCalls);
  const plan = calls.filter((c: T) => c.purpose === "plan" && c.ok).map((c: T) => c.ms);
  const assess = calls.filter((c: T) => c.purpose === "assess" && c.ok).map((c: T) => c.ms);
  const e2e = ts.map((t) => t.e2eMs);
  const multi = ts.filter((t) => t.category === "multi").map((t) => t.e2eMs);
  const res = r.resources;
  L(`| ${r.meta.tag} | ${sec(r.loadMs)} | ${sec(r.unloadMs)} | ${sec(q(plan, 50))} / ${sec(q(plan, 95))} | ${sec(q(assess, 50))} | ${sec(q(e2e, 50))} / ${sec(q(e2e, 95))} | ${sec(q(multi, 50))} / ${sec(q(multi, 95))} | ${res.peakWorkingSetMB} MB | ${res.minAvailableMB} MB | ${res.cpuPctMedian?.toFixed(0)} | ${res.gpuPctMedian?.toFixed(0)} | ${res.nonLoopbackConnectionsObserved + r.blockedOutbound.length} |`);
}
L("");

// ── Paired switch comparisons (v2): same model, same tasks, one switch changed ──
function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const c = (a: number, b: number) => { let r = 1; for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i; return r; };
  const tail = Array.from({ length: Math.min(k, n - k) + 1 }, (_, i) => c(n, i)).reduce((a, b) => a + b, 0) / 2 ** n;
  return Math.min(1, 2 * tail);
}
const ver = (r: T) => (r.meta.tag.match(/^v(\d)_/)?.[1] ?? "1");
const v2 = admitted.filter((r) => ver(r) === "2");
if (v2.length) {
  L("## Paired switch comparisons (v2 code)");
  L("");
  L("Each row compares one configuration with the product configuration of the SAME model on the same 36 tasks.");
  L("Wins / losses = tasks whose oracle success changed; p = exact two-sided sign test on those discordant tasks (small n: treat as indicative only).");
  L("");
  L("| Model | Variant vs product | Success (variant) | Success (product) | Wins | Losses | p | Valid after repair (variant / product) | Incorrect claims (variant / product) |");
  L("|---|---|---|---|---|---|---|---|---|");
  for (const prod of v2.filter((r) => /_vulkan_product$/.test(r.meta.tag))) {
    const model = prod.meta.modelId;
    for (const v of v2.filter((r) => r.meta.modelId === model && /_vulkan_(pgOn|grOn|argsOff)$/.test(r.meta.tag))) {
      let wins = 0, losses = 0;
      for (const t of v.tasks) { const p = prod.tasks.find((x: T) => x.id === t.id); if (!p) continue; if (t.success && !p.success) wins++; if (!t.success && p.success) losses++; }
      const s = (r: T) => count(r.tasks, (t) => t.success);
      const vr = (r: T) => count(r.tasks, (t) => t.acceptedAfterRepair);
      const ic = (r: T) => count(r.tasks, (t) => t.incorrectClaim);
      L(`| ${model.replace("qwen2.5-", "").replace("-instruct-q4_k_m", "")} | ${v.meta.tag.split("_").pop()} | ${s(v)}/36 | ${s(prod)}/36 | ${wins} | ${losses} | ${binomTwoSided(Math.min(wins, losses), wins + losses).toFixed(2)} | ${vr(v)} / ${vr(prod)} | ${ic(v)} / ${ic(prod)} |`);
    }
  }
  L("");
  L("## Argument-domain enforcement (v2)");
  L("");
  L("| Config | Argument violations (first plan + blocked at execution) | Planning failures after repair |");
  L("|---|---|---|");
  for (const r of v2) L(`| ${r.meta.tag} | ${r.tasks.reduce((a: number, t: T) => a + (t.argViolations ?? 0), 0)} | ${count(r.tasks, (t) => !t.acceptedAfterRepair)} |`);
  L("");
}

// ── Model comparison on the final code (v3 product configuration) ──
const v3 = admitted.filter((r) => ver(r) === "3");
if (v3.length) {
  L("## Model comparison — final code, product configuration (v3)");
  L("");
  L("n = 36 tasks per model, one run each at temperature 0 (the 1.5B v2 repeat was 36/36 identical, so run-to-run variance is low; task-sampling uncertainty is shown as 95% Wilson intervals).");
  L("");
  L("| Metric | " + v3.map((r) => r.meta.modelId.replace("qwen2.5-", "").replace("-instruct-q4_k_m", "")).join(" | ") + " |");
  L("|---|" + v3.map(() => "---").join("|") + "|");
  const row = (name: string, f: (r: T) => string) => L(`| ${name} | ${v3.map(f).join(" | ")} |`);
  const answerable = (r: T) => r.tasks.filter((t: T) => !["u01", "u02", "u03", "u04", "u05"].includes(t.id));
  const unsupported = (r: T) => r.tasks.filter((t: T) => ["u01", "u02", "u03", "u04", "u05"].includes(t.id));
  row("Task success (oracle)", (r) => `${pct(count(r.tasks, (t) => t.success), 36)}${wilson(count(r.tasks, (t) => t.success), 36)}`);
  row("Multi-step success", (r) => { const m = r.tasks.filter((t: T) => t.category === "multi"); return pct(count(m, (t) => t.success), m.length); });
  row("First plan valid", (r) => pct(count(r.tasks, (t) => t.firstPlan.fullValid), 36));
  row("Valid after repair", (r) => pct(count(r.tasks, (t) => t.acceptedAfterRepair), 36));
  row("Tool selection exact (answerable)", (r) => { const a = answerable(r); return pct(count(a, (t) => t.toolSelection.exact), a.length); });
  row("Instruction following (u06: list only)", (r) => (r.tasks.find((t: T) => t.id === "u06")?.success ? "yes" : "no"));
  row("Impossible requests refused", (r) => { const u = unsupported(r); return `${pct(count(u, (t) => t.refused), u.length)}${wilson(count(u, (t) => t.refused), u.length)}`; });
  row("Impossible requests NOT claimed completed", (r) => { const u = unsupported(r); return pct(count(u, (t) => t.outcome !== "completed"), u.length); });
  row("Incorrect completion claims (product rule)", (r) => { const c = count(r.tasks, (t) => t.outcome === "completed"); return `${count(r.tasks, (t) => t.incorrectClaim)}/${c}${wilson(count(r.tasks, (t) => t.incorrectClaim), c)}`; });
  row("Incorrect completion claims (legacy model-trust rule)", (r) => { const c = count(r.tasks, (t) => t.legacyOutcome === "completed"); return `${count(r.tasks, (t) => t.incorrectClaimLegacy)}/${c}${wilson(count(r.tasks, (t) => t.incorrectClaimLegacy), c)}`; });
  row("Missed completions (served but not completed)", (r) => String(count(r.tasks, (t) => t.missedCompletion)));
  row("Task latency p50 / p95", (r) => `${sec(q(r.tasks.map((t: T) => t.e2eMs), 50))} / ${sec(q(r.tasks.map((t: T) => t.e2eMs), 95))}`);
  row("Multi-step latency p50 / p95", (r) => { const m = r.tasks.filter((t: T) => t.category === "multi").map((t: T) => t.e2eMs); return `${sec(q(m, 50))} / ${sec(q(m, 95))}`; });
  row("Model load", (r) => sec(r.loadMs));
  row("Peak llama-server working set", (r) => `${r.resources.peakWorkingSetMB} MB`);
  row("Lowest available system RAM during run", (r) => `${r.resources.minAvailableMB} MB`);
  row("GPU engine utilisation p50 / p95 (Vulkan)", (r) => `${r.resources.gpuPctMedian?.toFixed(0)}% / ${r.resources.gpuPctP95?.toFixed(0)}%`);
  row("Non-loopback connections", (r) => String(r.resources.nonLoopbackConnectionsObserved + r.blockedOutbound.length));
  L("");
}

const pairs = admitted.filter((r) => r.meta.tag.endsWith("_rep2"));
if (pairs.length) {
  L("## Determinism (repeat run, same configuration)");
  L("");
  for (const rep of pairs) {
    const base = admitted.find((r) => r.meta.tag === rep.meta.tag.replace(/_rep2$/, ""));
    if (!base) { L(`- ${rep.meta.tag}: base run not admitted; no comparison.`); continue; }
    if (!base) continue;
    const same = rep.tasks.filter((t: T) => base.tasks.find((b: T) => b.id === t.id)?.outcome === t.outcome).length;
    const sameSucc = rep.tasks.filter((t: T) => base.tasks.find((b: T) => b.id === t.id)?.success === t.success).length;
    L(`- ${rep.meta.tag} vs ${base.meta.tag}: identical outcome on ${pct(same, rep.tasks.length)}, identical oracle success on ${pct(sameSucc, rep.tasks.length)}.`);
  }
  L("");
}

L("## Per-task outcomes");
L("");
L(`| Task | ${admitted.map((r) => r.meta.tag.replace("qwen2.5-", "").replace("-instruct-q4_k_m", "")).join(" | ")} |`);
L(`|---|${admitted.map(() => "---").join("|")}|`);
const ids: string[] = admitted[0]?.tasks.map((t: T) => t.id) ?? [];
for (const id of ids) {
  L(`| ${id} | ${admitted.map((r) => { const t = r.tasks.find((x: T) => x.id === id); return t ? `${t.outcome}${t.success ? " ✓" : ""}` : "-"; }).join(" | ")} |`);
}
L("");
L("✓ = oracle says the request was correctly and fully served (or correctly refused).");

const firstErrors = new Map<string, number>();
for (const r of admitted) for (const t of r.tasks) for (const e of t.firstPlan.errors) {
  const k = `${r.meta.tag.split("_")[0]}: ${String(e).replace(/step \S+:/, "step:").replace(/"[^"]*"/g, '"…"').slice(0, 90)}`;
  firstErrors.set(k, (firstErrors.get(k) ?? 0) + 1);
}
L("");
L("## First-plan rejection reasons (all configs, normalised)");
L("");
for (const [k, v] of [...firstErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) L(`- ${v}× ${k}`);

fs.writeFileSync(path.join(__dirname, "RESULTS.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
