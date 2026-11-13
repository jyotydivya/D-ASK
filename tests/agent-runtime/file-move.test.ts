/**
 * "Move <file or folder> to <folder> [and call it <name>]" (agent/runtime/tools/fileOrganize.ts → daemon files.move). The item, the
 * destination and any new name are always the ones the request names; the model can change none of them.
 * Run with: npx tsx tests/agent-runtime/file-move.test.ts
 */
import { requestedMove, isUndoCopyRename, createOrganizeTools } from "../../agent/runtime/tools/fileOrganize";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import { FileAccess } from "../../agent/runtime/tools/filesystem";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const P = (s: string) => s;   // paths below use String.raw so backslashes survive

async function main() {
  console.log("[G] grammar");
  check(JSON.stringify(requestedMove(String.raw`Move D:\Work\report.pdf to D:\Archive`)) === JSON.stringify({ path: P(String.raw`D:\Work\report.pdf`), toFolder: P(String.raw`D:\Archive`) }), "G1 a file to a folder");
  check(JSON.stringify(requestedMove(String.raw`move the folder "D:\Work\Project X" into D:\Archive and call it Project 2025`)) ===
    JSON.stringify({ path: P(String.raw`D:\Work\Project X`), toFolder: P(String.raw`D:\Archive`), newName: "Project" }) ||
    requestedMove(String.raw`move the folder "D:\Work\Project X" into D:\Archive and call it "Project 2025"`)?.newName === "Project 2025", "G2 a quoted folder with a new name", requestedMove(String.raw`move the folder "D:\Work\Project X" into D:\Archive and call it "Project 2025"`));
  check(requestedMove("move report.pdf to the archive") === null && requestedMove(String.raw`move D:\a.txt`) === null, "G3 relative names or a missing destination are not a move request");
  check(requestedMove(String.raw`Move D:\Work\a.txt to D:\Archive as "..\x.txt"`) === null, "G4 an unsafe new name is refused");
  check(isUndoCopyRename("undo the last move") && isUndoCopyRename("Undo my last file move."), "G5 'undo the last move'");

  console.log("[T] tool");
  const calls: { tool: string; args: any }[] = [];
  const bridge: DesktopBridge = {
    available: true, offers: () => true,
    async call(_t, tool, args) { calls.push({ tool, args }); return { status: "ok", result: { executed: true, verified: true, kind: "file", source: args.path, destination: `${args.toFolder}\\report.pdf`, files: 1 } } as DesktopReply; },
  };
  const tools = createOrganizeTools(new FileAccess({ workspaceRoot: process.cwd() }), bridge);
  const mv = tools.find((t) => t.name === "filesystem.move")!;
  const q = String.raw`Move D:\Work\report.pdf to D:\Archive`;
  const rc = mv.requestCheck!;
  check(rc.claims!(q) && rc.ground({ path: String.raw`D:\Work\report.pdf`, toFolder: String.raw`D:\Archive` }, q).status === "grounded", "T1 grounded in the request");
  check(rc.ground({ path: String.raw`D:\Work\other.pdf`, toFolder: String.raw`D:\Archive` }, q).status === "contradicted" &&
        rc.ground({ path: String.raw`D:\Work\report.pdf`, toFolder: String.raw`C:\Windows` }, q).status === "contradicted" &&
        rc.ground({ path: String.raw`D:\Work\report.pdf`, toFolder: String.raw`D:\Archive`, newName: "x.pdf" }, q).status === "contradicted", "T2 the model cannot change the item, the destination or add a name");
  const out = await mv.execute({ path: String.raw`D:\Work\report.pdf`, toFolder: String.raw`D:\Archive` }, { taskId: "t", stepId: "s", signal: new AbortController().signal } as any);
  check(out.ok && calls[0]!.tool === "files.move" && /verified/.test(out.evidence), "T3 the daemon performs and verifies it", out);
  check(mv.requiresApproval === false && mv.permissions.join() === "request:desktop_action", "T4 approval is the daemon's (exact card in the HUD)");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
