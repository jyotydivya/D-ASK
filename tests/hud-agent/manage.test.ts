/**
 * HUD management helpers: (1) the parsers read exactly what the real list tools produce, (2) every request a panel button builds is
 * accepted by the agent's own grammar with the same arguments (a closed loop: the panel can only ask for what the agent understands).
 * Run with: npx tsx tests/hud-agent/manage.test.ts
 */
import { parseMemories, parsePlugins, parseWorkflows, REQ, scheduleWhen } from "../../lib/manage";
import { pluginLine, grantedPermission, revokedPermission, enabledPlugin, disabledPlugin, installedPlugin, removedPlugin, isListPlugins } from "../../agent/runtime/tools/pluginTools";
import { deletedWorkflow, isListWorkflows, runWorkflowName, scheduledWorkflow, unscheduledWorkflow } from "../../agent/runtime/tools/workflows";
import { forgetMemoryId, isListMemories, createMemoryTools } from "../../agent/runtime/tools/memory";
import { parseManageRequest } from "../../agent/host/workflowManage";
import { MemoryStore } from "../../agent/runtime/memory/memoryStore";
import { parseVoiceTranscript } from "../../lib/voiceCommand";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 500)}` : ""}`); }
}

async function main() {
  console.log("\n[W] workflows");
  const wf = parseWorkflows("Done.\nnightly: 2 step(s), runs every day at 09:00 (last: submitted as task t1)\nmorning check: 1 step(s)\nweekly report: 3 step(s), runs every Monday at 08:30\nVerified: list the workflows (checked against the source by the tools).");
  check(wf?.length === 3 && wf[0]!.name === "nightly" && wf[0]!.steps === 2 && wf[0]!.schedule === "every day at 09:00" && wf[0]!.last === "submitted as task t1", "W1 name, steps, schedule and last note are read", wf);
  check(wf![1]!.name === "morning check" && wf![1]!.schedule === null && wf![2]!.schedule === "every Monday at 08:30", "W2 a name with a space, no schedule, a weekly schedule");
  check(JSON.stringify(parseWorkflows("No workflows are saved.")) === "[]" && parseWorkflows("REFUSED I cannot do that") === null, "W3 empty list vs. an unrelated reply (not parsed as a list)");
  check(isListWorkflows(REQ.listWorkflows()) && runWorkflowName(REQ.runWorkflow("nightly")) === "nightly" && runWorkflowName(REQ.runWorkflow("morning check")) === "morning check", "W4 list and run requests are understood by the agent grammar");
  check(deletedWorkflow(REQ.deleteWorkflow("weekly report")) === "weekly report" && unscheduledWorkflow(REQ.unscheduleWorkflow("morning check")) === "morning check" && deletedWorkflow(REQ.deleteWorkflow("a\"b c")) === "ab c", "W5 delete and unschedule requests (a name with spaces is quoted, a stray quote is dropped)");
  const when = scheduleWhen("daily", "09:05")!; const wk = scheduleWhen("Friday", "18:30")!;
  const s1 = scheduledWorkflow(REQ.scheduleWorkflow("nightly", when)); const s2 = scheduledWorkflow(REQ.scheduleWorkflow("weekly report", wk));
  check(s1?.name === "nightly" && s1.timing.kind === "daily" && s1.timing.time === "09:05" && s2?.name === "weekly report" && s2.timing.kind === "weekly" && s2.timing.day === "friday" && s2.timing.time === "18:30", "W6 schedule requests built from the panel's inputs parse to the same timing", [s1, s2]);
  check(scheduleWhen("daily", "9:5") === null && scheduleWhen("daily", "24:00") === null && scheduleWhen("daily", "") === null, "W7 an invalid time builds no request");
  for (const r of [REQ.runWorkflow("nightly"), REQ.deleteWorkflow("nightly"), REQ.unscheduleWorkflow("nightly"), REQ.listWorkflows(), REQ.scheduleWorkflow("nightly", when)]) {
    const m = parseManageRequest(r, [{ name: "nightly" }]);
    check(m.kind === "route" || m.kind === "none", `W8 the host's management router does not refuse: ${r}`, m);
  }

  console.log("\n[P] plugins");
  const line1 = pluginLine({ id: "note_reader", version: "1.0.0", approved: true, intact: true, enabled: true, declared: ["compute", "files.read", "memory.read"], granted: ["compute", "files.read"], tools: ["file_head", "my_notes"] });
  const line2 = pluginLine({ id: "text_tools", version: "1.0.0", approved: false, intact: false, declared: ["compute"], granted: [], tools: ["word_count", "title_case"] });
  const line3 = pluginLine({ id: "old_one", version: "0.9.0", approved: true, intact: false, enabled: true, declared: ["compute"], granted: [], tools: ["x_y"], problem: "files changed" });
  const line4 = pluginLine({ id: "off_one", version: "2.0.0", approved: true, intact: true, enabled: false, declared: ["compute", "files.read"], granted: ["compute"], tools: ["t_t"] });
  const ps = parsePlugins(["Done.", line1, line2, line3, line4].join("\n"))!;
  check(ps.length === 4 && ps[0]!.installed && ps[0]!.enabled && ps[0]!.permissions.length === 3 && ps[0]!.permissions[1]!.granted && !ps[0]!.permissions[2]!.granted && ps[0]!.tools.join() === "file_head,my_notes", "P1 an enabled plugin: every declared permission with its granted state, and its tools", ps[0]);
  check(!ps[1]!.installed && !ps[1]!.enabled, "P2 a plugin that is not installed");
  check(ps[2]!.installed && !ps[2]!.enabled && ps[2]!.changed && ps[2]!.note === "files changed", "P3 a changed plugin is shown as changed (and not enabled)", ps[2]);
  check(ps[3]!.installed && !ps[3]!.enabled && !ps[3]!.changed, "P4 a disabled plugin", ps[3]);
  check(JSON.stringify(parsePlugins("No plugins in the plugins folder.")) === "[]" && parsePlugins("nothing useful") === null, "P5 empty list vs. an unrelated reply");
  check(grantedPermission(REQ.grantPermission("note_reader", "files.read"))?.permission === "files.read" && revokedPermission(REQ.revokePermission("note_reader", "memory.read"))?.id === "note_reader"
    && installedPlugin(REQ.installPlugin("text_tools")) === "text_tools" && removedPlugin(REQ.removePlugin("text_tools")) === "text_tools" && enabledPlugin(REQ.enablePlugin("a_b")) === "a_b" && disabledPlugin(REQ.disablePlugin("a_b")) === "a_b" && isListPlugins(REQ.listPlugins()),
    "P6 every plugin request the panel builds is understood by the agent grammar, with the same id and permission");

  console.log("\n[M] memory");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dask-manage-"));
  const store = new MemoryStore(path.join(dir, "m.db"));
  store.remember({ kind: "preference", content: "my favourite editor is Neovim", source: "user" });
  store.remember({ kind: "person", content: "My sister Asha lives in Pune (Maharashtra)", source: "user" });
  const out = await createMemoryTools(store).find((t) => t.name === "memory.list")!.execute({}, { taskId: "t", signal: new AbortController().signal } as any);
  const ms = parseMemories(`Done.\n${out.evidence}`)!;
  check(ms.length === 2 && ms.every((m) => /^[0-9a-f]{8}$/.test(m.id)) && ms.some((m) => m.text === "my favourite editor is Neovim" && m.kind === "preference") && ms.some((m) => m.text.includes("(Maharashtra)") && m.kind === "person"), "M1 each memory's short id, text (even with parentheses) and kind are read from the real list output", ms);
  check(JSON.stringify(parseMemories("I have no saved memories.")) === "[]" && parseMemories("hello") === null, "M2 empty memory vs. an unrelated reply");
  check(isListMemories(REQ.listMemories()) && forgetMemoryId(REQ.forgetMemory(ms[0]!.id)) === ms[0]!.id, "M3 list and forget requests are understood by the agent grammar, with the same id");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log("\n[X] the reply shape seen in the real HUD (2026-11-12): doubled bullets and a repeated list");
  const realReply = "Done.\n• • note_reader 1.0.0 — installed, enabled — permissions: compute=granted, files.read=not granted, memory.read=not granted — tools: file_head, my_notes\n"
    + "• • note_reader 1.0.0 — installed, enabled — permissions: compute=granted, files.read=not granted, memory.read=not granted — tools: file_head, my_notes\nVerified: list the plugins (checked against the source by the tools).";
  const xp = parsePlugins(realReply);
  check(xp?.length === 1 && xp[0]!.id === "note_reader" && xp[0]!.permissions.length === 3 && !xp[0]!.permissions[1]!.granted, "X1 doubled bullets are accepted and the repeated plugin is shown once", xp);
  const xw = parseWorkflows("Done.\n• nightly: 2 step(s), runs every day at 09:00\n• nightly: 2 step(s), runs every day at 09:00\n• dropme: 1 step(s)");
  check(xw?.length === 2 && xw[0]!.name === "nightly" && xw[1]!.name === "dropme", "X2 workflow rows with the composer's bullet are accepted; duplicates collapse", xw);
  const xm = parseMemories("Done.\n• • [3fa4b2c1] my favourite editor is Neovim (preference)\n• • [3fa4b2c1] my favourite editor is Neovim (preference)");
  check(xm?.length === 1 && xm[0]!.id === "3fa4b2c1", "X3 memory rows with doubled bullets are accepted; duplicates collapse", xm);

  console.log("\n[U] the panel has no private channel");
  const panel = fs.readFileSync(path.join(process.cwd(), "components/ManagePanel.tsx"), "utf8");
  const orb = fs.readFileSync(path.join(process.cwd(), "components/JarvisOrb.tsx"), "utf8");
  check(!/\bfetch\s*\(|postMessage|XMLHttpRequest|WebSocket|window\.ipc|localStorage/.test(panel), "U1 the panel never calls the network, the host bridge or storage: it only submits ordinary requests through onRun");
  check(/<ManagePanel[^>]*onRun=\{\(request\) => void runCommand\(request\)\}/.test(orb) && /nativeShell && manageOpen/.test(orb), "U2 the HUD submits the panel's requests through runCommand (the same path as typed text) and shows the panel only in the native HUD");
  check(/destructive\(REQ\.deleteWorkflow/.test(panel) && /destructive\(REQ\.removePlugin/.test(panel) && /destructive\(REQ\.forgetMemory/.test(panel) && /CONFIRM\?/.test(panel), "U3 delete, remove and forget need a second click");
  check(/disabled=\{busy\}/.test(panel) && /BUTTONS ARE PAUSED/.test(panel), "U4 buttons are paused while a task runs (one task at a time)");

  console.log("\n[V] spoken results for voice-initiated requests");
  // V1: every request the microphone submits is first recorded in voiceCommandRef as EXACTLY the text it submits (uppercased, as askAssistant
  // records it in the history), so V2 speaks a result only for that voice request. Structural: inside the STT handler, every runCommand(X) is
  // immediately preceded by voiceCommandRef.current = X.toUpperCase() with the same X, and submission happens only for a parsed command.
  const sttBlock = orb.slice(orb.indexOf("fetch('/api/stt'"), orb.indexOf("STT Error"));
  const submits = [...sttBlock.matchAll(/runCommand\(/g)].length;
  const paired = [...sttBlock.matchAll(/voiceCommandRef\.current = ([\w.]+)\.toUpperCase\(\);\s*void runCommand\(([\w.]+)\)/g)];
  check(sttBlock.length > 0 && submits >= 1 && paired.length === submits && paired.every((m) => m[1] === m[2]) &&
    /const action = parseVoiceTranscript\(transcript\)/.test(sttBlock) && /action\.kind === "command"\)\s*\{\s*voiceCommandRef\.current = action\.text\.toUpperCase\(\);\s*void runCommand\(action\.text\)/.test(sttBlock) &&
    /void askAssistant\(rawCommand\.trim\(\)\)/.test(orb) && /command: prompt\.toUpperCase\(\)/.test(orb),
    "V1a every microphone submission records exactly the text it submits (one parsed path for plain and wake-word speech)", { submits, paired: paired.map((m) => m[0]) });
  // Behavioural, for both microphone paths: the recorded key equals the history key askAssistant will write (trim, then uppercase);
  // a wake word alone submits nothing; a mid-sentence D-ASK is not a wake word (the whole request is submitted).
  const historyKey = (submitted: string) => submitted.trim().toUpperCase();
  const paths = [" What is seven times eight? ", "D-ASK, what is seven times eight?", "According to my research papers, when is the D-ASK evaluation deadline? Then remember it."];
  const acts = paths.map((t) => parseVoiceTranscript(t.trim()));
  check(acts.every((a) => a.kind === "command" && a.text.toUpperCase() === historyKey(a.text)) &&
    (acts[0] as { viaWakeWord: boolean }).viaWakeWord === false && (acts[1] as { viaWakeWord: boolean; text: string }).viaWakeWord === true && (acts[1] as { text: string }).text === "what is seven times eight?" &&
    (acts[2] as { viaWakeWord: boolean; text: string }).viaWakeWord === false && (acts[2] as { text: string }).text === paths[2] &&
    parseVoiceTranscript("D-ASK").kind === "wake-only" && parseVoiceTranscript("hmm").kind === "ignore",
    "V1b both microphone paths: the recorded key matches the submitted request; wake word only at the start; nothing submitted for a bare wake word", acts);
  check(/pending\.command === voiceCommandRef\.current/.test(orb) && /speakIfVoiceTask\(response\)/.test(orb) && /speakIfVoiceTask\(`That failed\./.test(orb), "V2 a result (or a failure) is spoken only when it belongs to that voice-submitted request; typed requests are not read aloud");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
