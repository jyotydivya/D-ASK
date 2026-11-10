/**
 * File organisation, agent side: request grammar, deterministic plan, preview, and the daemon request through the real
 * AgentRuntime with a scripted model and a fake daemon (which performs the moves on a temp folder, as the real daemon does).
 * The real daemon's validation, approval and moves are covered by tests/DAsk.Daemon.Tests/FileOrganizeTests.cs.
 * Run with: npx tsx tests/agent-runtime/file-organize.test.ts
 */
import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync, mkdtempSync, renameSync, mkdirSync, utimesSync } from "node:fs";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { clarificationFor, groundCall } from "../../agent/runtime/grounding";
import { FileAccess } from "../../agent/runtime/tools/filesystem";
import { MAX_BATCH, MAX_BATCH_TEXT, isOrganizePreview, isOrganizeRequest, isUndoOrganize, movesText, organizeFolders, organizeRule, planOrganize } from "../../agent/runtime/tools/fileOrganize";
import { actuationRefusal, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import { parseRequest } from "../../agent/host/protocol";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted"; calls: StructuredRequest[] = [];
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { this.calls.push(req); return structuredClone(req.purpose === "plan" ? (this.plans.length > 1 ? this.plans.shift() : this.plans[0]) : SAT); }
}
const plan = (tool: string, input: Record<string, unknown>) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: [{ id: "s1", description: tool, tool, input, dependsOn: [] }] });

/** Fake daemon: approves (or denies) and performs the listed moves exactly, like FileOrganizeRequestService. */
class FakeDaemon implements DesktopBridge {
  available = true; deny = false; lie = false;
  calls: { tool: string; args: any }[] = [];
  journal: { folder: string; moves: { name: string; into: string }[] } | null = null;
  offers(t: string) { return t === "files.organize" || t === "files.undo_organize"; }
  async call(_task: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push({ tool, args: structuredClone(args) });
    if (this.deny) return { status: "error", error: { code: "approval_denied", message: "You declined. Nothing was moved." } };
    if (tool === "files.organize") {
      const a = args as { folder: string; moves: { name: string; into: string }[] };
      for (const m of a.moves) { mkdirSync(path.join(a.folder, m.into), { recursive: true }); renameSync(path.join(a.folder, m.name), path.join(a.folder, m.into, m.name)); }
      this.journal = { folder: a.folder, moves: a.moves };
      return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: !this.lie, moved: a.moves.length, total: a.moves.length, folder: a.folder, moves: a.moves.map((m) => ({ ...m, done: true })) } };
    }
    const j = this.journal!;
    for (const m of j.moves) renameSync(path.join(j.folder, m.into, m.name), path.join(j.folder, m.name));
    return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: true, moved: j.moves.length, total: j.moves.length, folder: j.folder, moves: j.moves.map((m) => ({ name: m.name, from: m.into, done: true })) } };
  }
}

async function main() {
  const TMP = mkdtempSync(path.join(os.tmpdir(), "dask-organize-"));
  const DL = path.join(TMP, "Downloads");
  const put = async (n: string, mtime?: string) => { await fs.mkdir(DL, { recursive: true }); await fs.writeFile(path.join(DL, n), n); if (mtime) utimesSync(path.join(DL, n), new Date(mtime), new Date(mtime)); };
  for (const [n, t] of [["report.pdf", "2026-10-03"], ["notes.txt", "2026-10-05"], ["photo.JPG", "2026-11-01"], ["budget.xlsx", "2026-09-30"], ["song.mp3", "2026-11-02"], ["mystery.qqq", "2026-11-03"], ["setup.exe", "2026-11-04"]]) await put(n, t);
  await put(".env"); await put("id_rsa");
  await fs.mkdir(path.join(DL, "Old stuff"), { recursive: true }); await fs.writeFile(path.join(DL, "Old stuff", "inner.pdf"), "x");
  const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
  const reg = (d?: DesktopBridge) => createDefaultRegistry(TMP, { fileRoots: [DL], ...(d ? { desktop: d } : {}) });
  const run = (d: DesktopBridge | undefined, model: LanguageModel, objective: string) => new AgentRuntime({ model, registry: reg(d), granted: GRANTS }).run({ taskId: `o${Math.random()}`.replace(".", ""), objective });
  const ASK = `Organize the files in "${DL}" by type`;

  console.log("\n[G] grammar");
  check(organizeRule(ASK) === "type" && organizeRule("sort the downloads folder by month") === "month" && organizeRule("organise by extension the docs folder") === "extension", "G1 rules: by type / month / extension");
  check(JSON.stringify(organizeFolders(ASK)) === JSON.stringify([DL]) && JSON.stringify(organizeFolders("Tidy up the Downloads folder by type")) === '["downloads"]', "G2 the folder is the one named (absolute path or 'the X folder')", organizeFolders(ASK));
  check(isOrganizeRequest(ASK) && !isOrganizePreview(ASK) && isOrganizePreview(`Show me how you would organize the files in "${DL}" by type`), "G3 preview is distinguished from doing it");
  check(isUndoOrganize("Undo the last file organisation") && !isOrganizeRequest("Undo the last file organisation"), "G4 undo is its own request");
  check(/by type .* by month .* by extension/.test(clarificationFor(reg(new FakeDaemon()), `Organize the files in "${DL}"`) ?? ""), "G5 no rule named -> asks how, decides nothing");
  check(actuationRefusal(ASK) === null, "G6 an organise request is not refused as desktop actuation");

  console.log("\n[P] the plan (deterministic, top level only, nothing hidden)");
  {
    const acc = new FileAccess({ workspaceRoot: TMP, extraRoots: [DL] });
    const r = await planOrganize(acc, DL, "type", new AbortController().signal);
    const p = r.ok ? r.plan : null;
    check(!!p && movesText(p.moves) === "budget.xlsx → Spreadsheets\\\nnotes.txt → Documents\\\nphoto.JPG → Images\\\nreport.pdf → Documents\\\nsetup.exe → Installers\\\nsong.mp3 → Audio\\",
      "P1 by type: exact, sorted moves; unknown types stay", p && movesText(p.moves));
    check(!!p && p.leftInPlace.some((l) => l.name === "mystery.qqq") && !JSON.stringify(p).includes(".env") && !JSON.stringify(p).includes("id_rsa") && !JSON.stringify(p).includes("inner.pdf"),
      "P2 unknown types left in place; secret files and subfolder contents never planned");
    const m = await planOrganize(acc, DL, "month", new AbortController().signal);
    check(m.ok && m.plan.moves.find((x) => x.name === "report.pdf")?.into === "2026-10" && m.plan.moves.find((x) => x.name === "budget.xlsx")?.into === "2026-09", "P3 by month: YYYY-MM of the modification time");
    const BIG = path.join(TMP, "Big"); await fs.mkdir(BIG);
    for (let i = 0; i < 70; i++) await fs.writeFile(path.join(BIG, `scan-${String(i).padStart(3, "0")}-with-a-fairly-long-descriptive-name.pdf`), "x");
    const big = await planOrganize(new FileAccess({ workspaceRoot: TMP, extraRoots: [BIG] }), BIG, "type", new AbortController().signal);
    check(big.ok && big.plan.batch.length <= MAX_BATCH && movesText(big.plan.batch).length <= MAX_BATCH_TEXT && big.plan.remaining === 70 - big.plan.batch.length && big.plan.remaining > 0,
      "P4 large folders are split: the first batch fits one approval card; the rest is reported as remaining", big.ok && { batch: big.plan.batch.length, remaining: big.plan.remaining });
  }

  console.log("\n[R] through the real runtime");
  {
    const d = new FakeDaemon();
    const prev = await run(d, new Scripted([plan("filesystem.plan_organize", { folder: DL, by: "type" })]), `Show me how you would organize the files in "${DL}" by type`);
    check(prev.outcome === "completed" && d.calls.length === 0 && existsSync(path.join(DL, "report.pdf")) && /Preview only \(nothing was moved\)/.test(prev.response), "R1 preview completes, moves nothing, never calls the daemon", { o: prev.outcome, r: prev.response });

    const wrong = await run(d, new Scripted([plan("filesystem.organize", { folder: path.join(TMP), by: "type" })]), ASK);
    check(wrong.outcome !== "completed" && d.calls.length === 0, "R2 a folder the request did not name never reaches the daemon", wrong.outcome);
    const wrongRule = await run(d, new Scripted([plan("filesystem.organize", { folder: DL, by: "month" })]), ASK);
    check(wrongRule.outcome !== "completed" && d.calls.length === 0, "R3 a rule the request did not ask for never reaches the daemon");

    d.deny = true;
    const denied = await run(d, new Scripted([plan("filesystem.organize", { folder: DL, by: "type" })]), ASK);
    check(denied.outcome !== "completed" && /declined/.test(denied.response) && existsSync(path.join(DL, "report.pdf")), "R4 denied: nothing moved, reported honestly", denied.response);
    d.deny = false; d.calls = [];

    const ok = await run(d, new Scripted([plan("filesystem.organize", { folder: DL, by: "type" })]), ASK);
    const sent = d.calls[0]?.args;
    check(ok.outcome === "completed" && d.calls.length === 1 && d.calls[0]!.tool === "files.organize" && sent.folder === DL && sent.moves.length === 6 && Object.keys(sent).sort().join() === "folder,moves",
      "R5 approved: ONE daemon request with the canonical folder and exactly the computed moves; completed", { o: ok.outcome, sent, r: ok.response });
    check(existsSync(path.join(DL, "Documents", "report.pdf")) && existsSync(path.join(DL, "mystery.qqq")) && /Undo is available/.test(ok.response), "R6 the files are where the plan said; the undo hint is shown");

    const undo = await run(d, new Scripted([plan("filesystem.undo_organize", {})]), "Undo the last file organisation");
    check(undo.outcome === "completed" && d.calls.at(-1)!.tool === "files.undo_organize" && JSON.stringify(d.calls.at(-1)!.args) === "{}" && existsSync(path.join(DL, "report.pdf")), "R7 undo: one request with no arguments; files back", { o: undo.outcome, r: undo.response });

    await run(d, new Scripted([plan("filesystem.organize", { folder: DL, by: "type" })]), ASK);   // something to undo
    const before = d.calls.length;
    const many = await run(d, new Scripted([{ intent: "task", goal: "g", successCriteria: ["x"], steps: Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, description: "undo", tool: "filesystem.undo_organize", input: {}, dependsOn: [] })) }]), "Undo the last file organisation");
    check(many.outcome === "completed" && d.calls.length - before === 1, "R7b the local model's 8 identical undo steps become ONE daemon request (observed in the real-HUD run)", { o: many.outcome, calls: d.calls.length - before });
    d.lie = true;
    const unverified = await run(d, new Scripted([plan("filesystem.organize", { folder: DL, by: "type" })]), ASK);
    check(unverified.outcome !== "completed", "R8 a move the daemon could not verify is never reported as completed", unverified.outcome);
    d.lie = false;

    const noBridge = reg();
    check(noBridge.get("filesystem.organize") === undefined && noBridge.get("filesystem.undo_organize") === undefined && noBridge.get("filesystem.plan_organize") !== undefined,
      "R9 without the daemon bridge only the read-only preview exists");
    check(groundCall(reg(new FakeDaemon()), "filesystem.organize", { folder: DL, by: "type" }, ASK).status === "grounded", "R10 the planned call is grounded in the request");
  }

  console.log("\n[H] protocol");
  {
    const hello = (tools: string[]) => JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "t", emergencyStopped: false, stopGeneration: 0, desktop: { proto: 2, tools } } });
    let ok = false; try { ok = (parseRequest(hello(["desktop.list_windows", "files.organize", "files.undo_organize"])).params as any).desktop.tools.length === 3; } catch { ok = false; }
    check(ok, "H1 the daemon's offer of files.organize / files.undo_organize is accepted");
    let refused = false; try { parseRequest(hello(["files.delete"])); } catch { refused = true; }
    check(refused, "H2 any other files.* name is refused");
  }

  await fs.rm(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
