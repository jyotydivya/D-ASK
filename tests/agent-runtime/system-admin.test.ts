/**
 * Windows administration, agent side (2026-11-14). Run with: npx tsx tests/agent-runtime/system-admin.test.ts
 *   G. grammar: natural language -> exactly one system.* request with the request's own arguments (or nothing)
 *   E. end to end through the real AgentRuntime with a scripted model and a fake daemon
 * The live daemon path (real processes, services, radios, volume, brightness, startup, power) is covered by SystemAdminLiveTests.cs.
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { actuationRefusal, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import { systemRequest } from "../../agent/runtime/tools/systemAdmin";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
class FakeDaemon implements DesktopBridge {
  available = true;
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private replies: DesktopReply[], private notOffered: string[] = []) {}
  offers(tool: string) { return !this.notOffered.includes(tool); }
  async call(_t: string, tool: string, args: Record<string, unknown>) { this.calls.push({ tool, args }); return structuredClone(this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!); }
}
const plan = (steps: { id: string; tool: string; input: Record<string, unknown> }[]) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: steps.map((s) => ({ description: s.tool, dependsOn: [], ...s })) });
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? this.plans[0] : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" }); }
}
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
const run = (bridge: DesktopBridge, model: LanguageModel, objective: string) =>
  new AgentRuntime({ model, registry: createDefaultRegistry(ROOT, { desktop: bridge }), granted: GRANTS }).run({ taskId: `t${Math.random()}`.replace(".", ""), objective });

async function main() {
  console.log("\n[G] Grammar");
  const cases: [string, unknown][] = [
    ["Restart the computer in 5 minutes", { tool: "system.power", args: { action: "restart", delaySeconds: 300 } }],
    ["Shut down my PC", { tool: "system.power", args: { action: "shutdown", delaySeconds: 60 } }],
    ["Sign out of Windows in 2 minutes", { tool: "system.power", args: { action: "signout", delaySeconds: 120 } }],
    ["Put the computer to sleep", { tool: "system.power", args: { action: "sleep", delaySeconds: 60 } }],
    ["Cancel the restart", { tool: "system.cancel_power", args: {} }],
    ["Cancel the scheduled shutdown", { tool: "system.cancel_power", args: {} }],
    ["Turn off Wi-Fi", { tool: "system.set_radio", args: { radio: "wifi", state: "off" } }],
    ["Turn bluetooth on", { tool: "system.set_radio", args: { radio: "bluetooth", state: "on" } }],
    ["Disable wifi", { tool: "system.set_radio", args: { radio: "wifi", state: "off" } }],
    ["Set the volume to 40%", { tool: "system.set_volume", args: { percent: 40 } }],
    ["Mute the sound", { tool: "system.set_volume", args: { mute: true } }],
    ["unmute", { tool: "system.set_volume", args: { mute: false } }],
    ["What's the volume?", { tool: "system.audio_status", args: {} }],
    ["Set brightness to 70", { tool: "system.set_brightness", args: { percent: 70 } }],
    ["What is my screen resolution?", { tool: "system.display_status", args: {} }],
    ["Am I connected to wifi?", { tool: "system.network_status", args: {} }],
    ["Show network adapters", { tool: "system.network_status", args: {} }],
    ["Show my startup apps", { tool: "system.startup_apps", args: {} }],
    ["Disable OneDrive at startup", { tool: "system.startup_toggle", args: { name: "OneDrive", enabled: false } }],
    ["Stop the Spooler service", { tool: "system.service_control", args: { name: "Spooler", action: "stop" } }],
    ["Is the Spooler service running?", { tool: "system.service_info", args: { name: "Spooler" } }],
    ["List running services", { tool: "system.list_services", args: {} }],
    ["Kill notepad", { tool: "system.end_process", args: { name: "notepad" } }],
    ["End process 1234", { tool: "system.end_process", args: { pid: 1234 } }],
    ["Show running processes", { tool: "system.list_processes", args: {} }],
    ["List processes named chrome", { tool: "system.list_processes", args: { filter: "chrome" } }],
  ];
  for (const [q, want] of cases) check(JSON.stringify(systemRequest(q)) === JSON.stringify(want), `G ${q}`, systemRequest(q));
  for (const q of ["Turn off the computer and then open Notepad", "Restart the computer in 10 seconds", "Set the volume to 400", "Kill wifi", "What windows are open?", "Restart in 3 hours"])
    check(systemRequest(q) === null, `G not an admin request (or out of bounds): ${q}`, systemRequest(q));
  check(actuationRefusal("Kill notepad") === null && actuationRefusal("Kill notepad", (t) => t !== "system.end_process") !== null,
    "G 'kill notepad' is an approval request when the daemon offers it; refused otherwise");

  console.log("\n[E] End to end");
  {
    const d = new FakeDaemon([{ v: 2, kind: "reply", callId: "c1", status: "ok", result: { executed: true, verified: true, radio: "WiFi", state: "Off", observed: "WiFi is now Off (read back from Windows)" } } as any]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "system.set_radio", input: { radio: "wifi", state: "off" } }])]), "Turn off Wi-Fi");
    check(r.outcome === "completed" && d.calls.length === 1 && JSON.stringify(d.calls[0]!.args) === JSON.stringify({ radio: "wifi", state: "off" }) && /read back/.test(r.response),
      "E1 turn off Wi-Fi: exactly the request's radio and state reach the daemon; completed only when read back", { o: r.outcome, r: r.response, c: d.calls });
    const d2 = new FakeDaemon([{ status: "ok", result: { verified: true } } as any]);
    const r2 = await run(d2, new Scripted([plan([{ id: "s1", tool: "system.set_radio", input: { radio: "bluetooth", state: "off" } }])]), "Turn off Wi-Fi");
    check(r2.outcome !== "completed" && d2.calls.length === 0, "E2 a different radio planned by the model never reaches the daemon");
  }
  {
    const d = new FakeDaemon([
      { status: "ok", result: { verified: true, count: 1, processes: [{ name: "notepad", pid: 4321 }] } } as any,
      { status: "ok", result: { executed: true, verified: true, process: "notepad", pid: 4321, observed: "notepad (process 4321) is no longer running" } } as any,
    ]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "system.end_process", input: { name: "notepad" } }])]), "Kill notepad");
    check(r.outcome === "completed" && d.calls.map((c) => c.tool).join() === "system.process_info,system.end_process" && (d.calls[1]!.args as any).pid === 4321,
      "E3 'kill notepad': the name resolves to exactly one pid (read), then ONE approval-gated end of that pid", { o: r.outcome, c: d.calls });
    const d2 = new FakeDaemon([{ status: "ok", result: { verified: true, count: 2, processes: [{ name: "notepad", pid: 1 }, { name: "notepad", pid: 2 }] } } as any]);
    const r2 = await run(d2, new Scripted([plan([{ id: "s1", tool: "system.end_process", input: { name: "notepad" } }])]), "Kill notepad");
    check(r2.outcome !== "completed" && d2.calls.every((c) => c.tool !== "system.end_process") && /pid/.test(r2.response), "E4 two matching processes: nothing is ended; asks for the pid", { r: r2.response });
  }
  {
    const d = new FakeDaemon([{ status: "ok", result: { executed: true, verified: false, action: "restart", observed: "shutdown.exe accepted the restart, but its event-log record was not found" } } as any]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "system.power", input: { action: "restart", delaySeconds: 300 } }])]), "Restart the computer in 5 minutes");
    check(r.outcome !== "completed", "E5 an unverified scheduled restart is not reported as done", { o: r.outcome });
    const d2 = new FakeDaemon([{ status: "ok", result: { executed: true, verified: true, cancelled: "restart", observed: "cancelled; Windows reports nothing pending any more" } } as any]);
    const r2 = await run(d2, new Scripted([plan([{ id: "s1", tool: "system.cancel_power", input: {} }])]), "Cancel the restart");
    check(r2.outcome === "completed" && /nothing pending/.test(r2.response), "E6 cancel the restart", { o: r2.outcome, r: r2.response });
  }
  {
    const d = new FakeDaemon([{ status: "ok", result: { verified: true, hasOutput: true, volumePercent: 26, muted: false, devices: [{ name: "Realtek High Definition Audio", status: "OK" }] } } as any]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "system.audio_status", input: {} }])]), "What's the volume?");
    check(r.outcome === "completed" && /26%/.test(r.response) && /Realtek/.test(r.response), "E7 a read is answered from the daemon's values", { r: r.response });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
