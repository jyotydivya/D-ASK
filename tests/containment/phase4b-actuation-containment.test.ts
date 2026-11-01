/**
 * Phase 4B-1R.6 - Legacy Desktop Actuation Containment Tests
 *
 * Run with: npx tsx tests/containment/phase4b-actuation-containment.test.ts
 *
 * Two blocking layers are tested:
 *   Layer 1: mouseKeyboard.ts runCommand() - blocks pyautogui sidecar commands
 *   Layer 2: pcAgent.ts routeTool() - blocks all actuation tools before any service call
 *
 * Note: medium/high tools with requiresApproval:true are also blocked, but at the
 * policy layer (before routeTool). Both are correct; we verify success=false for all.
 */

import { MouseKeyboardController } from "../../lib/agent/tools/desktop/mouseKeyboard";
import { PCAgent } from "../../agent/agents/pcAgent";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log("  PASS: " + message);
    passed++;
  } else {
    console.error("  FAIL: " + message);
    failed++;
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, sub: string, label: string): Promise<void> {
  try {
    await fn();
    console.error("  FAIL (no throw): " + label);
    failed++;
  } catch (e: any) {
    if (e.message && e.message.includes(sub)) {
      console.log("  PASS: " + label);
      passed++;
    } else {
      console.error("  FAIL (wrong msg): " + label + " | got: " + e.message);
      failed++;
    }
  }
}

async function main() {
  // ── Suite 1: MouseKeyboardController sidecar bridge ───────────────────────
  // The guard in runCommand() throws before execFile is ever invoked.

  console.log("\n[Suite 1] MouseKeyboardController sidecar bridge blocks actuation commands");
  {
    const ctrl = new MouseKeyboardController();
    const cases: [string, () => Promise<unknown>][] = [
      ["moveMouse",  () => ctrl.moveMouse(0, 0)],
      ["click",      () => ctrl.click("left", 1)],
      ["scroll",     () => ctrl.scroll(5)],
      ["typeText",   () => ctrl.typeText("hello")],
      ["pressKey",   () => ctrl.pressKey("enter")],
      ["hotkey",     () => ctrl.hotkey(["ctrl", "c"])],
    ];
    for (const [name, fn] of cases) {
      await assertThrowsAsync(fn, "Phase 4B-1R.6 containment", name + "() throws containment error");
    }
  }

  // ── Suite 2a: auto-approved actuation tools reach routeTool and are blocked ─
  // These are low/medium risk with requiresApproval:false — policy auto-approves
  // them, so the containment guard in routeTool is the active safety boundary.

  console.log("\n[Suite 2a] Auto-approved actuation tools blocked by routing guard (valid args)");
  {
    const agent = new PCAgent();
    const ctx = {
      taskId: "test-task", nodeId: "test-node",
      objective: "test", nodeDescription: "test",
      agentType: "pc" as const, previousOutputs: {},
    };

    const CASES: [string, Record<string, unknown>][] = [
      // PyAutoGUI (low, no approval)
      ["pc.mouse_move",         { x: 0, y: 0 }],
      ["pc.press_key",          { key: "enter" }],
      // SendKeys via PowerShell (low, no approval)
      ["pc.manage_window",      { action: "minimize" }],
      ["pc.volume_up",          { steps: 5 }],
      ["pc.volume_down",        { steps: 5 }],
      ["pc.toggle_mute",        {}],
      // Shell execution (low, no approval)
      ["pc.launch_application", { application: "notepad" }],
      ["pc.close_application",  { application: "notepad" }],
      ["pc.youtube_play",       { query: "test" }],
      ["pc.web_search",         { query: "test" }],
      ["pc.check_weather",      {}],
      ["pc.send_whatsapp",      { message: "hi" }],
      ["pc.send_telegram",      { message: "hi" }],
      ["pc.launch_steam",       {}],
      ["pc.launch_epic",        {}],
      ["pc.set_reminder",       { minutes: 5, message: "test" }],
      // WMI write (low, no approval)
      ["pc.set_brightness",     { level: 50 }],
      // Filesystem mutation (medium, no approval)
      ["file.copy",             { sourcePath: "a.txt", destPath: "b.txt" }],
      ["file.move",             { sourcePath: "a.txt", destPath: "b.txt" }],
    ];

    for (const [toolName, args] of CASES) {
      const res = await (agent as any).callTool(ctx, toolName, args);
      assert(res.success === false, "callTool(" + toolName + ") success=false");
      assert(
        typeof res.error === "string" && res.error.includes("Phase 4B-1R.6 containment"),
        "callTool(" + toolName + ") error contains containment marker"
      );
    }
  }

  // ── Suite 2b: approval-gated actuation tools also remain blocked ───────────
  // These are medium/high with requiresApproval:true — policy blocks first.
  // The containment guard in routeTool is never reached, but the tools ARE blocked.
  // (Policy blocking is equally safe; routeTool guard is defense-in-depth.)

  console.log("\n[Suite 2b] Policy-gated actuation tools remain blocked");
  {
    const agent = new PCAgent();
    const ctx = {
      taskId: "test-task", nodeId: "test-node",
      objective: "test", nodeDescription: "test",
      agentType: "pc" as const, previousOutputs: {},
    };

    const CASES: [string, Record<string, unknown>][] = [
      ["pc.mouse_click",   { button: "left", clicks: 1 }],
      ["pc.type_text",     { text: "hello" }],
      ["pc.hotkey",        { keys: ["ctrl", "c"] }],
      ["pc.set_power_state", { state: "sleep" }],
      ["file.write",       { path: "test.txt", content: "hi" }],
      ["file.delete",      { path: "test.txt" }],
    ];

    for (const [toolName, args] of CASES) {
      const res = await (agent as any).callTool(ctx, toolName, args);
      assert(res.success === false, "callTool(" + toolName + ") success=false (policy or containment blocked)");
    }
  }

  // ── Suite 3: Read-only tools are NOT blocked ──────────────────────────────

  console.log("\n[Suite 3] Read-only tools are NOT blocked by containment guard");
  {
    const agent = new PCAgent();
    const ctx = {
      taskId: "test-task", nodeId: "test-node",
      objective: "test", nodeDescription: "test",
      agentType: "pc" as const, previousOutputs: {},
    };

    const READ_ONLY: [string, Record<string, unknown>][] = [
      ["pc.get_active_window", {}],
      ["pc.list_windows",      {}],
      ["pc.system_status",     {}],
      ["pc.top_processes",     { sortBy: "cpu", limit: 3 }],
      ["pc.network_info",      {}],
      ["file.read",            { path: "package.json" }],
      ["file.list",            { path: "." }],
    ];

    for (const [toolName, args] of READ_ONLY) {
      const res = await (agent as any).callTool(ctx, toolName, args);
      const isContainmentBlock =
        typeof res.error === "string" && res.error.includes("Phase 4B-1R.6 containment");
      assert(!isContainmentBlock, "callTool(" + toolName + ") NOT blocked by containment guard");
    }
  }

  // ── Suite 4: takeScreenshot not blocked ───────────────────────────────────

  console.log("\n[Suite 4] takeScreenshot is NOT blocked by sidecar guard");
  {
    const ctrl = new MouseKeyboardController();
    try {
      await ctrl.takeScreenshot();
      console.log("  PASS: takeScreenshot() completes without containment error");
      passed++;
    } catch (e: any) {
      const isContainmentBlock = e.message && e.message.includes("Phase 4B-1R.6 containment");
      assert(!isContainmentBlock, "takeScreenshot() NOT blocked by containment guard");
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n" + "-".repeat(60));
  console.log("Phase 4B-1R.6 Containment Tests: " + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
}

main().catch(e => {
  console.error("Test runner error:", e);
  process.exit(1);
});
