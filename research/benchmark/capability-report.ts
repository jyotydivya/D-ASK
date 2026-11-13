/**
 * Phase 5: evaluate the experimental capability check.
 *   npx tsx research/benchmark/capability-report.ts     writes research/benchmark/CAPABILITY.md
 *
 * Part 1 is the deterministic classifier alone over the Phase 4 suite and the Phase 5 set.
 * Part 2 compares full runs (results/p5_*_capOff.json vs p5_*_capOn.json) when present.
 */
import fs from "node:fs";
import path from "node:path";
import { assessCapability } from "../../agent/runtime/capabilityCheck";
import { createDefaultRegistry } from "../../agent/runtime/defaults";
import { TASKS } from "./tasks";
import { CAPABILITY_TASKS } from "./capabilityTasks";

const ROOT = path.resolve(__dirname, "..", "..");
const reg = createDefaultRegistry(ROOT);
const L: string[] = [];
const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "n/a");
function wilson(n: number, d: number): string {
  if (!d) return "";
  const z = 1.96, p = n / d, den = 1 + z * z / d;
  const c = (p + z * z / (2 * d)) / den, h = (z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d))) / den;
  return ` [${Math.max(0, 100 * (c - h)).toFixed(0)}–${Math.min(100, 100 * (c + h)).toFixed(0)}]`;
}

L.push("# Capability check evaluation (experimental, off by default)", "", `Generated ${new Date().toISOString()}. Every number is computed from the task lists and result files.`, "");
L.push("## 1. Classifier alone (no model)", "");

type Row = { id: string; objective: string; answerable: boolean; group: string };
const phase4: Row[] = TASKS.filter((t) => t.id !== "f01" && t.id !== "f02" && t.id !== "f03" && t.id !== "f04").map((t) => ({ id: t.id, objective: t.objective, answerable: !t.expectRefusal, group: `phase4-${t.expectRefusal ? "unsupported" : "answerable"}` }));
const heldOut: Row[] = CAPABILITY_TASKS.map((t) => ({ id: t.id, objective: t.objective, answerable: t.answerable, group: t.category }));

function table(title: string, rows: Row[]) {
  L.push(`### ${title}`, "", "| Group | n | refused | supported | ambiguous |", "|---|---|---|---|---|");
  const groups = [...new Set(rows.map((r) => r.group))];
  for (const g of groups) {
    const rs = rows.filter((r) => r.group === g);
    const v = rs.map((r) => assessCapability(reg, r.objective).verdict);
    L.push(`| ${g} | ${rs.length} | ${v.filter((x) => x === "unsupported").length} | ${v.filter((x) => x === "supported").length} | ${v.filter((x) => x === "ambiguous").length} |`);
  }
  const ans = rows.filter((r) => r.answerable), imp = rows.filter((r) => !r.answerable && !r.group.includes("ambiguous"));
  const fr = ans.filter((r) => assessCapability(reg, r.objective).verdict === "unsupported");
  const cr = imp.filter((r) => assessCapability(reg, r.objective).verdict === "unsupported");
  L.push("", `- **False refusals** (answerable but refused): ${pct(fr.length, ans.length)}${wilson(fr.length, ans.length)}${fr.length ? `: ${fr.map((r) => `${r.id} "${r.objective}"`).join("; ")}` : ""}`);
  L.push(`- **Correct refusals** (impossible and refused): ${pct(cr.length, imp.length)}${wilson(cr.length, imp.length)}`);
  const miss = imp.filter((r) => assessCapability(reg, r.objective).verdict !== "unsupported");
  if (miss.length) L.push(`- Impossible requests NOT refused (they go to the planner, and verification still caps them): ${miss.map((r) => `${r.id} "${r.objective}"`).join("; ")}`);
  L.push("");
}
table("Phase 4 suite (the word lists were written with these in view: not independent)", phase4);
table("Phase 5 set (written after the word lists were frozen)", heldOut);

const DIR = path.join(__dirname, "results");
const runs = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^p5_.*_cap(On|Off)\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))) : [];
if (runs.length) {
  L.push("## 2. Full runs through the runtime, real local model", "");
  L.push("Measured. Temperature 0, one run per configuration. `refusal correct` counts impossible requests refused; `tools run on impossible` counts impossible requests where a tool was executed anyway.", "");
  L.push("| Config | n | Answerable served | False refusals | Impossible refused | Tools run on impossible | Incorrect completion claims | Ambiguous claimed completed | Median task time |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    if (!r.admitted) { L.push(`| ${r.meta.tag} | not admitted by the memory guard | | | | | | | |`); continue; }
    const ts: any[] = r.tasks;
    const ans = ts.filter((t) => t.answerable && !t.inject), imp = ts.filter((t) => !t.answerable && t.category !== "ambiguous"), amb = ts.filter((t) => t.category === "ambiguous");
    const served = ans.filter((t) => t.success).length;
    const fr = ans.filter((t) => t.refused).length;
    const ms = [...ts.map((t) => t.e2eMs)].sort((a, b) => a - b)[Math.floor(ts.length / 2)];
    L.push(`| ${r.meta.tag} | ${ts.length} | ${pct(served, ans.length)}${wilson(served, ans.length)} | ${pct(fr, ans.length)} | ${pct(imp.filter((t) => t.refused).length, imp.length)}${wilson(imp.filter((t) => t.refused).length, imp.length)} | ${pct(imp.filter((t) => t.toolCalls > 0).length, imp.length)} | ${ts.filter((t) => t.incorrectClaim).length} | ${amb.filter((t) => t.outcome === "completed").length}/${amb.length} | ${(ms / 1000).toFixed(1)} s |`);
  }
  L.push("");
}

fs.writeFileSync(path.join(__dirname, "CAPABILITY.md"), L.join("\n") + "\n");
console.log(L.join("\n"));
