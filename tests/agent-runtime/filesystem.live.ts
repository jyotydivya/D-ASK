/**
 * Phase 7A, live: natural-language filesystem tasks through the REAL local agent (llama-server + local model,
 * real Planner/Verifier/tools). Synthetic project in a temp folder; nothing personal is read.
 *
 *   npx tsx tests/agent-runtime/filesystem.live.ts [--model qwen2.5-0.5b-instruct-q4_k_m] [--out <json>]
 *
 * Network: an in-process guard blocks and records any non-loopback connection from this process, and the OS
 * TCP table is checked for llama-server connections to anything but loopback. This is NOT a Wi-Fi-off test.
 *
 * Hard checks are correctness invariants (a "completed" answer must contain the real files and lines; a request
 * that names no file must never complete; nothing leaves the machine). Whether the small model picks the right
 * tool for each request is measured and reported, and checked for the requests the product must handle.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, writeFileSync } from "node:fs";
import { LlamaServerModel } from "../../agent/runtime/inference/llamaServerModel";
import { InferenceSupervisor } from "../../agent/runtime/inference/supervisor";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import type { RunReport } from "../../agent/runtime/types";

const ROOT = path.resolve(__dirname, "..", "..");
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const modelId = arg("model");
const outFile = arg("out");

// ── Network guard ───────────────────────────────────────────────────────────
const blocked: string[] = [];
const origConnect = net.Socket.prototype.connect;
(net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown }).connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; path?: string } | number;
  const host = typeof first === "object" && first ? (first.host ?? (first.path ? `pipe:${first.path}` : "localhost")) : typeof args[1] === "string" ? args[1] : "localhost";
  if (!/^(127\.|::1$|localhost$|pipe:)/.test(host)) { blocked.push(host); throw new Error(`blocked outbound connection to ${host}`); }
  return (origConnect as (...a: unknown[]) => unknown).apply(this, args);
};
delete process.env.DASK_INFERENCE;

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail).slice(0, 500)}` : "")); }
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "dask-fs-live-"));
const PROJ = path.join(TMP, "project");
async function fixtures(): Promise<void> {
  const W = async (rel: string, data: string | Buffer) => { await fs.mkdir(path.dirname(path.join(PROJ, rel)), { recursive: true }); await fs.writeFile(path.join(PROJ, rel), data); };
  await W("README.md", "# Demo project\nA synthetic project.\n");
  await W("docs/architecture.md", "# Architecture\n\nThe architecture has three layers.\nNothing else here.\n");
  await W("docs/guide.md", "# Guide\nHow to use the demo.\n");
  await W("docs/reports/2026-q2-report.md", "# Q2 Report\n\n## 1. Introduction\nOlder report.\n");
  await W("docs/reports/2026-q3-report.md", "# Q3 Report\n\n## 1. Introduction\nThis quarter the team rebuilt the architecture.\nIt now runs fully offline.\n\n## 2. Results\nLatency fell by half.\n");
  await fs.utimes(path.join(PROJ, "docs/reports/2026-q2-report.md"), new Date("2026-07-01"), new Date("2026-07-01"));
  await fs.utimes(path.join(PROJ, "docs/reports/2026-q3-report.md"), new Date("2026-10-01"), new Date("2026-10-01"));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 255]), Buffer.from("\n%%EOF\n")]);
  await W("docs/manual.pdf", pdf);
  await W("reports/annual-2025.pdf", pdf);
  await W(".env", "SECRET=architecture\n");
  await fs.mkdir(path.join(PROJ, "logs"), { recursive: true });
  await Promise.all(Array.from({ length: 2000 }, (_, i) => fs.writeFile(path.join(PROJ, "logs", `run-${i}.log`), `entry ${i}\n`.repeat(50))));
}

function llamaRemoteConnections(): string[] {
  const ps = "$ids=@(Get-Process llama-server -ErrorAction SilentlyContinue).Id; Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemoteAddress -notmatch '^(127\\.|::1$|0\\.0\\.0\\.0$|::$)' } | ForEach-Object { \"$($_.RemoteAddress):$($_.RemotePort)\" }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true });
  return (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function llamaWorkingSetMB(): number {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"], { encoding: "utf8", windowsHide: true });
  return Math.round(Number(r.stdout.trim() || 0) / 1024 / 1024);
}

interface Row { id: string; objective: string; outcome: string; ms: number; tools: string[]; verified: boolean; unexplained: string[]; response: string }

async function main(): Promise<void> {
  await fixtures();
  const sup = new InferenceSupervisor({ root: ROOT, backend: "auto", idleUnloadMs: 0, readyTimeoutMs: 180_000, modelId });
  const model = new LlamaServerModel({ endpoint: sup.endpoint, requestTimeoutMs: 120_000 });
  const runtime = new AgentRuntime({
    model, registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS,
    limits: { modelTimeoutMs: 120_000, runTimeoutMs: 300_000 },
  });
  const rows: Row[] = [];
  const runTask = async (id: string, objective: string, signal?: AbortSignal): Promise<RunReport> => {
    const t0 = Date.now();
    const r = await runtime.run({ taskId: id, objective, signal });
    const row: Row = {
      id, objective, outcome: r.outcome, ms: Date.now() - t0, tools: r.steps.map((s) => `${s.step.tool}${JSON.stringify(s.step.input)}`),
      verified: !!r.verification?.independentlyVerified, unexplained: r.verification?.unexplained ?? [], response: r.response,
    };
    rows.push(row);
    console.log(`[live] ${id.padEnd(4)} ${r.outcome.padEnd(10)} ${String(row.ms).padStart(6)} ms  ${row.tools.join(" + ") || "-"}`);
    return r;
  };

  try {
    // The five acceptance requests, exactly as written.
    const a = await runTask("A", "Find all PDF files in my authorized project directory");
    const b = await runTask("B", "Find the latest report and show its metadata");
    const c = await runTask("C", "Read the introduction of this report");
    const d = await runTask("D", "Find every occurrence of the term architecture in the project documentation");
    const e = await runTask("E", "Summarize the report using its actual contents");
    // The same intents with the file named, as a self-contained request must name it.
    const c2 = await runTask("C2", "Read the introduction of docs/reports/2026-q3-report.md");
    const e2 = await runTask("E2", "Summarize docs/reports/2026-q3-report.md using its actual contents");
    const m = await runTask("M", "When was docs/reports/2026-q3-report.md last modified?");
    // The original four tools still work with the larger registry.
    const r1 = await runTask("R1", "What is (17+25)*2?");
    const r2 = await runTask("R2", "What time is it?");
    const r3 = await runTask("R3", "How much memory does this computer have?");
    const r4 = await runTask("R4", "List the files in the docs folder");

    console.log("\n[invariants]");
    const completed = (r: RunReport) => r.outcome === "completed";
    for (const r of [a, b, c, d, e, c2, e2, m, r1, r2, r3, r4]) {
      check(!completed(r) || r.verification?.independentlyVerified, `${r.taskId}: completed only with independent verification`);
    }
    check(!completed(a) || (a.response.includes("docs/manual.pdf") && a.response.includes("reports/annual-2025.pdf") && !a.response.includes(".env")), "A: a completed answer lists exactly the real PDFs", a.response);
    const firstHit = b.response.split("\n").find((l) => l.startsWith("- ")) ?? "";
    check(!completed(b) || /docs\/reports\/2026-q3-report\.md — .*modified 2026-10-01.*created/.test(firstHit), "B: a completed answer puts the newest report first, with its metadata", b.response);
    check(!completed(c), "C: 'this report' names no file, so it can never be reported completed", c.outcome);
    check(!completed(d) || /docs\/architecture\.md:3: The architecture has three layers\./.test(d.response), "D: a completed answer has the real file and line", d.response);
    check(!completed(e) && !completed(e2), "E/E2: a summary is never reported as verified", [e.outcome, e2.outcome]);
    check(!completed(c2) || (c2.response.includes("lines 3–") && c2.response.includes("rebuilt the architecture")), "C2: a completed read shows the section's real text and lines", c2.response);
    check(![a, b, c, d, e, c2, e2, m].some((r) => r.response.includes("SECRET=")), "no answer contains the .env file's content");

    console.log("\n[product requests the real model must handle]");
    check(completed(a), "A completes with the real model", a.outcome);
    check(completed(b), "B completes with the real model", b.outcome);
    check(completed(c2), "C2 completes with the real model", c2.outcome);
    check(completed(d), "D completes with the real model", d.outcome);
    check(completed(r1), "R1 (math) still completes", r1.outcome);

    console.log("\n[cancellation during real inference and a long content search]");
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runTask("X", "Find every occurrence of the term needle in the project", ac.signal);
    setTimeout(() => ac.abort(), 1500);
    const x = await p;
    check(x.outcome === "cancelled" && Date.now() - t0 < 5000, "a cancelled task ends as cancelled, promptly", { outcome: x.outcome, ms: Date.now() - t0 });

    console.log("\n[network]");
    const remote = llamaRemoteConnections();
    check(blocked.length === 0, "this process attempted no non-loopback connection", blocked);
    check(remote.length === 0, "llama-server has no non-loopback TCP connection", remote);

    const status = sup.status();
    const summary = {
      at: new Date().toISOString(), model: status.modelId, backend: status.backend, llamaWorkingSetMB: llamaWorkingSetMB(),
      hostRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024), blocked, remote, rows,
    };
    if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2));
    console.log(`\nmodel ${status.modelId} (${status.backend}); llama-server ${summary.llamaWorkingSetMB} MB; this process ${summary.hostRssMB} MB`);
  } finally {
    await sup.stop("test done");
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .catch((err) => { failed++; console.error("UNCAUGHT", err); })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
