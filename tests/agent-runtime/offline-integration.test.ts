/**
 * Offline integration: real local model, end to end through POST /api/tasks.
 *
 *   npx tsx tests/agent-runtime/offline-integration.test.ts                    monitored mode
 *   npx tsx tests/agent-runtime/offline-integration.test.ts --require-offline  networking-disabled mode
 *
 * --require-offline first PROVES the machine has no network (DNS and an outbound
 * TCP connect must both fail) and refuses to run otherwise. That is the genuine
 * "networking disabled" test: switch Wi-Fi/Ethernet off (or airplane mode), then run it.
 * Monitored mode runs the same flow with networking available and proves no
 * connection leaves loopback — it does NOT prove the system works with no network.
 *
 * In both modes: cloud API keys are present (fake values), DASK_INFERENCE is unset,
 * every socket the Node process opens is recorded (non-loopback is blocked), and the
 * OS TCP table of the Node and llama-server processes is sampled during the run.
 */
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";

// Two separate tallies. Infrastructure (N*) = isolation, hosting, health. Functional (F*/R*) =
// whether each user request was actually served correctly. Reaching a terminal state is NOT success.
const tally = { infra: { passed: 0, failed: 0 }, functional: { passed: 0, failed: 0 } };
function checkAs(kind: "infra" | "functional", cond: boolean, label: string, detail?: unknown): void {
  if (cond) { tally[kind].passed++; console.log(`  PASS [${kind}]: ${label}`); }
  else { tally[kind].failed++; console.error(`  FAIL [${kind}]: ${label}${detail !== undefined ? ` | ${JSON.stringify(detail)}` : ""}`); }
}
const check = (cond: boolean, label: string, detail?: unknown) => checkAs("infra", cond, label, detail);

/** Functional expectations, checked against the actual tool outputs (not the model's claims). */
interface FunctionalCase {
  id: string;
  objective: string;
  kind: "answer" | "refuse";
  /** For "answer": the executed output that proves the request was served. */
  proof?: (steps: { tool: string; status: string; output: Record<string, unknown> | undefined }[]) => boolean;
}
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CASES: FunctionalCase[] = [
  { id: "F1", objective: "What time is it?", kind: "answer", proof: (s) => s.some((x) => x.tool === "system.time" && x.status === "succeeded" && x.output?.timeZone === localZone) },
  { id: "F2", objective: "What is (17+25)*2?", kind: "answer", proof: (s) => s.some((x) => x.tool === "math.evaluate" && x.status === "succeeded" && x.output?.value === 84) },
  { id: "F3", objective: "How much memory does this computer have?", kind: "answer", proof: (s) => s.some((x) => x.tool === "system.info" && x.status === "succeeded") },
  { id: "F4", objective: "Is it morning or evening for me right now?", kind: "answer", proof: (s) => s.some((x) => x.tool === "system.time" && x.status === "succeeded" && x.output?.timeZone === localZone) },
  { id: "R1", objective: "Send an email to my boss saying I'm late", kind: "refuse" },
];
const requireOffline = process.argv.includes("--require-offline");

async function networkReachable(): Promise<{ dns: boolean; tcp: boolean }> {
  const dnsOk = await dns.resolve4("example.com").then(() => true, () => false);
  const tcpOk = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3_000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
  return { dns: dnsOk, tcp: tcpOk };
}

function psAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}
async function tcpOf(pid: number): Promise<{ pid: number; local: string; remote: string; state: string }[]> {
  const out = await psAsync(`Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress)|$($_.RemoteAddress)|$($_.State)" }`);
  return out ? out.split(/\r?\n/).map((l) => { const [local, remote, state] = l.split("|"); return { pid, local, remote, state }; }) : [];
}
const loopbackOrNone = (a: string) => ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(a);

async function main(): Promise<void> {
  console.log(`\nMode: ${requireOffline ? "NETWORKING-DISABLED (--require-offline)" : "MONITORED (network available)"}`);
  const reach = await networkReachable();
  console.log(`  network probe: DNS ${reach.dns ? "reachable" : "unreachable"}, outbound TCP ${reach.tcp ? "reachable" : "unreachable"}`);
  if (requireOffline) {
    if (reach.dns || reach.tcp) {
      console.error("PRECONDITION NOT MET: networking is enabled. Disable Wi-Fi/Ethernet (or airplane mode) and re-run. Nothing was tested.");
      process.exit(2);
    }
    check(true, "N0 precondition: no DNS and no outbound TCP (networking genuinely disabled)");
  }

  // Socket guard (installed after the probe).
  const attempts: { host: string; port: unknown }[] = [];
  const orig = net.Socket.prototype.connect;
  (net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown }).connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; port?: unknown; path?: string } | number;
    const host = typeof first === "object" && first ? (first.host ?? (first.path ? `pipe:${first.path}` : "localhost")) : typeof args[1] === "string" ? args[1] : "localhost";
    attempts.push({ host, port: typeof first === "object" && first ? first.port : first });
    if (!/^(127\.|::1$|localhost$|pipe:)/.test(host)) throw new Error(`blocked outbound connection to ${host}`);
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };

  delete process.env.DASK_INFERENCE;
  delete process.env.DASK_AGENT_ENGINE;
  process.env.GROQ_API_KEY = "gsk_offline_integration_fake";
  process.env.OPENROUTER_API_KEY = "sk-or-offline-integration-fake";
  const T = randomBytes(32).toString("base64url");
  process.env.DASK_API_TASK_TOKEN = T;
  process.env.DASK_API_APPROVE_TOKEN = randomBytes(32).toString("base64url");

  const { POST } = await import("../../app/api/tasks/route");
  const { taskService } = await import("../../services/taskService");
  const { eventService } = await import("../../services/eventService");
  const { getLocalSupervisor } = await import("../../agent/runtime/inference");
  const sup = getLocalSupervisor();

  const samples: Awaited<ReturnType<typeof tcpOf>> = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const pids = [process.pid, sup.status().pid].filter((p): p is number => !!p);
      for (const pid of pids) samples.push(...await tcpOf(pid));
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // Pass-through observer of the default runtime's reports (no behaviour change), so the
  // functional checks can inspect real tool outputs rather than the model's claims.
  const { AgentRuntime } = await import("../../agent/runtime/runtime");
  type Report = Awaited<ReturnType<InstanceType<typeof AgentRuntime>["run"]>>;
  const reports = new Map<string, Report>();
  const origRun = AgentRuntime.prototype.run;
  AgentRuntime.prototype.run = async function (this: InstanceType<typeof AgentRuntime>, opts) {
    const r = await origRun.call(this, opts);
    reports.set(opts.taskId, r);
    return r;
  };
  const fstats = { answered: 0, answerable: 0, refusedOrUnverified: 0, refuseCases: 0, incorrectClaims: 0, planningFailures: 0, argumentFailures: 0 };

  for (const fc of CASES) {
    const objective = fc.objective;
    const t0 = Date.now();
    const res = await POST(new Request("http://localhost:3000/api/tasks", {
      method: "POST", headers: { host: "localhost:3000", authorization: `Bearer ${T}`, "content-type": "application/json" }, body: JSON.stringify({ objective }),
    }) as never);
    const { taskId } = await res.json() as { taskId: string };
    let status = taskService.getTask(taskId)?.status;
    for (let i = 0; i < 1_800 && !["completed", "failed", "cancelled"].includes(status ?? ""); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = taskService.getTask(taskId)?.status;
    }
    const history = eventService.getHistory(taskId, 500);
    const engine = history.find((e) => e.type === "task.created")?.payload.engine;
    const end = history.find((e) => e.type === "task.completed" || e.type === "task.failed");
    console.log(`  RESULT "${objective}": status=${status} outcome=${String(end?.payload.outcome)} ms=${Date.now() - t0}`);
    console.log(`         response: ${String(end?.payload.finalResponse ?? end?.payload.error ?? "").replace(/\n/g, " | ").slice(0, 300)}`);
    check(res.status === 201 && engine === "runtime", `N1 "${objective}" ran on the local agent runtime`, { status: res.status, engine });
    check(status === "completed" || status === "failed", `N2 "${objective}" reached a terminal state through the local model`, { status, lastError: sup.status().lastError });

    // ── Functional: did the request actually get served (or correctly not claimed)? ──
    const rep = reports.get(taskId);
    const steps = (rep?.steps ?? []).map((s) => ({ tool: s.step.tool, status: s.status, output: s.outcome?.output as Record<string, unknown> | undefined, error: s.error }));
    const outcome = rep?.outcome ?? "missing";
    if (/^Planning failed/.test(rep?.error ?? "")) fstats.planningFailures++;
    fstats.argumentFailures += steps.filter((s) => /^Not executed:/.test(s.error ?? "")).length;
    console.log(`         outcome=${outcome} steps=${steps.map((s) => `${s.tool}:${s.status}`).join(", ") || "-"}${rep?.error ? ` error=${rep.error.slice(0, 160)}` : ""}`);
    if (fc.kind === "answer") {
      fstats.answerable++;
      const proven = !!fc.proof?.(steps);
      const served = proven && outcome === "completed";
      if (served) fstats.answered++;
      if (outcome === "completed" && !proven) fstats.incorrectClaims++;
      checkAs("functional", outcome !== "completed" || proven, `${fc.id} no incorrect completion claim for "${objective}"`, { outcome });
      checkAs("functional", served, `${fc.id} "${objective}" was actually served (tool output proves it) and reported completed`, { outcome, steps });
    } else {
      fstats.refuseCases++;
      const ok = outcome !== "completed";
      if (ok) fstats.refusedOrUnverified++; else fstats.incorrectClaims++;
      checkAs("functional", ok, `${fc.id} impossible request "${objective}" is refused or left unverified, never completed`, { outcome });
    }
  }
  AgentRuntime.prototype.run = origRun;
  const supStatus = sup.status();
  console.log(`  supervisor: state=${supStatus.state} backend=${supStatus.backend} restarts=${supStatus.restarts}`);
  check(supStatus.state === "ready" || supStatus.state === "degraded", "N3 the local model server was used and is healthy", supStatus.lastError);

  sampling = false;
  await sampler;
  await sup.stop("integration test done");

  const outside = attempts.filter((a) => !/^(127\.|::1$|localhost$|pipe:)/.test(a.host));
  check(outside.length === 0, "N4 zero non-loopback connection attempts from the Node host process", outside);
  check(attempts.length > 0, "N4 (the guard did observe the loopback inference traffic)", attempts.length);
  const badOs = samples.filter((s) => !(loopbackOrNone(s.local) && loopbackOrNone(s.remote)));
  console.log(`  OS TCP samples: ${samples.length} (pids ${[...new Set(samples.map((s) => s.pid))].join(", ")})`);
  check(samples.some((s) => s.pid !== process.pid), "N5 the llama-server process was sampled");
  check(badOs.length === 0, "N5 OS TCP table: every connection of the Node host and llama-server is loopback", badOs.slice(0, 10));

  const i = tally.infra, f = tally.functional;
  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`Offline infrastructure:        ${i.passed}/${i.passed + i.failed} assertions passed`);
  console.log(`Functional task success:       ${fstats.answered}/${fstats.answerable} answerable requests served and reported completed`);
  console.log(`Correct refusal/unverified:    ${fstats.refusedOrUnverified}/${fstats.refuseCases} impossible requests not claimed as completed`);
  console.log(`Incorrect completion claims:   ${fstats.incorrectClaims}`);
  console.log(`Planning failures (after repair): ${fstats.planningFailures}; tool-argument validation failures at execution: ${fstats.argumentFailures}`);
  console.log(`Functional assertions:         ${f.passed}/${f.passed + f.failed} passed`);
  console.log(`Model: ${process.env.DASK_LOCAL_MODEL || "default (first manifest entry)"}`);
  if (!requireOffline) console.log("NOTE: monitored mode — networking was available. Isolation was proven separately with --require-offline (Wi-Fi off).");
  process.exit(i.failed === 0 && f.failed === 0 ? 0 : 1);
}

process.on("beforeExit", () => { console.error("FATAL: event loop drained before the suite finished"); process.exit(1); });
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
