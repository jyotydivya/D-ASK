/**
 * Notes, agent side: request grammar (title + exact quoted text), the notes.create tool through the real AgentRuntime with a
 * scripted model and a fake daemon that really writes into a temporary notes folder, and the independent artifact check.
 * The daemon's validation, approval, no-overwrite write and read-back are covered by tests/DAsk.Daemon.Tests/NoteCreateTests.cs.
 * Run with: npx tsx tests/agent-runtime/notes.test.ts
 */
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { clarificationFor, detectFacets, groundCall } from "../../agent/runtime/grounding";
import { isNoteRequest, requestedNote, spokenQuotes, verifyNoteFile } from "../../agent/runtime/tools/notes";
import { parseRequest } from "../../agent/host/protocol";
import type { DesktopBridge, DesktopReply } from "../../agent/runtime/tools/desktop";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const SAT = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" };
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? (this.plans.length > 1 ? this.plans.shift() : this.plans[0]) : SAT); }
}
const plan = (tool: string, input: Record<string, unknown>) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: [{ id: "s1", description: tool, tool, input, dependsOn: [] }] });

// The exact transcript of the failing real-HUD test (whisper output).
const SPOKEN = 'Create a note titled Meeting. The note should contain the exact words "Remember to submit the project report by Friday".';
const TEXT = "Remember to submit the project report by Friday";
// The exact acceptance request, typed as spoken (no quote characters).
const TYPED = "Create a note titled Meeting. The note should contain the exact words, open quote, remember to submit the project report by Friday, close quote.";

type Mode = "write" | "deny" | "corrupt" | "missing" | "outside" | "fail";
/** Behaves like NoteCreateRequestService: writes <dir>\<title>.txt (never overwriting) and reports executed/verified. */
class FakeDaemon implements DesktopBridge {
  available = true; offered = true; mode: Mode = "write";
  calls: { tool: string; args: any }[] = [];
  constructor(readonly dir: string, readonly elsewhere: string) {}
  offers(t: string) { return this.offered && t === "notes.create"; }
  async call(_t: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push({ tool, args: structuredClone(args) });
    const a = args as { title: string; text: string };
    const file = path.join(this.mode === "outside" ? this.elsewhere : this.dir, `${a.title}.txt`);
    const ok = (f: string) => ({ v: 2 as const, kind: "reply" as const, callId: "c1", status: "ok" as const, result: { decision: "approved", consumed: true, executed: true, verified: true, title: a.title, file: f, folder: this.dir } });
    const err = (code: string, message: string) => ({ v: 2 as const, kind: "reply" as const, callId: "c1", status: "error" as const, error: { code, message } });
    switch (this.mode) {
      case "deny": return err("approval_denied", "You declined. Nothing was written.");
      case "fail": return err("not_verified", "The note was not created: the note could not be written (IOException).");
      case "missing": return ok(file);                                   // claims success, wrote nothing
      case "corrupt": writeFileSync(file, a.text.replace(/"/g, "'") + " "); return ok(file);
      default:
        if (existsSync(file)) return err("target_refused", "a note named that already exists; nothing is overwritten. Nothing was written.");
        writeFileSync(file, Buffer.from(a.text, "utf8"), { flag: "wx" }); return ok(file);
    }
  }
}

async function main() {
  console.log("\n[G] grammar");
  check(JSON.stringify(requestedNote(SPOKEN)) === JSON.stringify({ title: "Meeting", text: TEXT }), "G1 the real-HUD transcript: title Meeting, the exact quoted words", requestedNote(SPOKEN));
  const PUNCT = 'Make a new note called "Q&A, v2" that says "Don\'t forget: it\'s 50% done (really?!) — ask Ana; then file it."';
  check(JSON.stringify(requestedNote(PUNCT)) === JSON.stringify({ title: "Q&A, v2", text: "Don't forget: it's 50% done (really?!) — ask Ana; then file it." }), "G2 quoted title; punctuation inside the text kept exactly", requestedNote(PUNCT));
  check(requestedNote("Write a note named Ideas with the text \u201CTry the blue theme.\u201D")?.text === "Try the blue theme.", "G3 curly quotes: the text, with its own full stop, kept");
  check(requestedNote('Create a note titled Meeting Notes: "Room 4, 10:30."')?.title === "Meeting Notes", "G4 multi-word title ends at the colon");
  check(requestedNote("Create a note titled Meeting saying remember the report") === null, "G5 unquoted text is not guessed");
  check(requestedNote('Create a note titled Meeting containing "a" and "b"') === null, "G6 two quoted texts: ambiguous, not guessed");
  check(requestedNote('Create a note containing "hello"') === null, "G7 no title: not guessed");
  check(requestedNote('Create a note titled ..\\..\\Windows\\evil containing "x"') === null && requestedNote('Create a note titled CON containing "x"') === null,
    "G8 a title that is not a plain file name is refused (no path, no device name)");
  check(!isNoteRequest('Type "hello" into the notes field of the window titled "Notes"') && !isNoteRequest('Write a note in Notepad saying "hi"'),
    "G9 typing into an app is desktop input, not a note file");
  check(JSON.stringify(requestedNote(TYPED)) === JSON.stringify({ title: "Meeting", text: "remember to submit the project report by Friday" }),
    "G10 the exact request typed with spoken markers: same note, the words exactly as given", requestedNote(TYPED));
  check(spokenQuotes("Make a note called Todo saying quote buy milk, eggs unquote.") === 'Make a note called Todo saying "buy milk, eggs".'
    && spokenQuotes("please quote me on that") === "please quote me on that" && spokenQuotes('a "real" quote close quote') === 'a "real" quote close quote',
    "G11 spoken markers: quote…unquote converted; a lone marker or real quotes leave the text unchanged");

  const dir = mkdtempSync(path.join(os.tmpdir(), "dask-notes-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "dask-elsewhere-"));
  try {
    const d = new FakeDaemon(dir, elsewhere);
    const registry = () => createDefaultRegistry(process.cwd(), { desktop: d });
    // The tool reads DASK_NOTES_DIR at registry creation (the daemon passes it); set it for these runs.
    process.env.DASK_NOTES_DIR = dir;

    console.log("\n[C] request ownership");
    {
      const reg = registry();
      const f = detectFacets(reg, SPOKEN);
      check(f.length === 1 && f[0]!.tool === "notes.create" && clarificationFor(reg, SPOKEN) === null,
        "C1 the note request is owned by notes.create (no desktop, memory or other facets; no question)", f.map((x) => x.id));
      check(groundCall(reg, "notes.create", { title: "Meeting" }, SPOKEN).status === "grounded" && groundCall(reg, "notes.create", { title: "Other" }, SPOKEN).status === "contradicted",
        "C2 only the request's title is grounded");
      check(/titled/.test(clarificationFor(reg, 'Create a note containing "x"') ?? "") && /in quotes/.test(clarificationFor(reg, "Create a note titled Meeting saying hello") ?? ""),
        "C3 a missing title or unquoted text: a question, not a guess");
      d.offered = false;
      check(/not enabled/.test(clarificationFor(registry(), SPOKEN) ?? "") && detectFacets(registry(), SPOKEN).length === 0, "C4 notes not offered by the daemon: says so, no facet");
      d.offered = true;
    }

    console.log("\n[T] notes.create through the runtime (fake daemon writing a real temporary folder)");
    const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
    const run = (model: LanguageModel, objective: string) => new AgentRuntime({ model, registry: registry(), granted: GRANTS }).run({ taskId: `n${Math.random()}`.replace(".", ""), objective });
    {
      const r = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      const file = path.join(dir, "Meeting.txt");
      check(r.outcome === "completed" && JSON.stringify(d.calls[0]?.args) === JSON.stringify({ title: "Meeting", text: TEXT }),
        "T1 completed; the daemon received exactly the title and text (the model supplied only the title)", { o: r.outcome, call: d.calls[0], resp: r.response });
      check(existsSync(file) && readFileSync(file, "utf8") === TEXT, "T2 the artifact: Meeting.txt holds exactly the requested words");
      check(/Created the note "Meeting"/.test(r.response), "T3 reported as created only after verification", r.response);

      const n = d.calls.length;
      const wrong = await run(new Scripted([plan("notes.create", { title: "Agenda" })]), SPOKEN);
      check(wrong.outcome !== "completed" && d.calls.length === n, "T4 a different title from the model never reaches the daemon", { o: wrong.outcome });

      const again = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(again.outcome !== "completed" && readFileSync(file, "utf8") === TEXT, "T5 an existing note is never overwritten; not reported as created", { o: again.outcome, r: again.response });
      rmSync(file);

      const PQ = 'Create a note titled Quotes containing "She said \'yes\', then left \u2014 at 5:30pm; ok?"';
      const pq = await run(new Scripted([plan("notes.create", { title: "Quotes" })]), PQ);
      check(pq.outcome === "completed" && readFileSync(path.join(dir, "Quotes.txt"), "utf8") === "She said 'yes', then left \u2014 at 5:30pm; ok?", "T6 quotation marks and punctuation preserved byte for byte", { o: pq.outcome, r: pq.response, calls: d.calls.slice(-1) });

      d.mode = "deny";
      const denied = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(denied.outcome !== "completed" && /Nothing was written/.test(denied.response) && !existsSync(file), "T7 approval declined: not completed, nothing written, said so", { o: denied.outcome, r: denied.response });

      d.mode = "fail";
      const failedWrite = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(failedWrite.outcome !== "completed" && /not created/.test(failedWrite.response), "T8 failed write: not completed, reported", { o: failedWrite.outcome, r: failedWrite.response });

      d.mode = "missing";
      const missing = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(missing.outcome !== "completed" && !/Created the note/.test(missing.response), "T9 daemon claims success but no file exists: not completed (artifact re-read)", { o: missing.outcome, r: missing.response });

      d.mode = "corrupt";
      const corrupt = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(corrupt.outcome !== "completed" && !/Created the note/.test(corrupt.response), "T10 file content differs from the request: not completed", { o: corrupt.outcome, r: corrupt.response });
      rmSync(file, { force: true });

      d.mode = "outside";
      const outside = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(outside.outcome !== "completed", "T11 a note outside the notes folder is not accepted as the result", { o: outside.outcome });
      d.mode = "write";

      const typed = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), TYPED);
      check(typed.outcome === "completed" && readFileSync(file, "utf8") === "remember to submit the project report by Friday", "T13 the exact typed request: completed, the file holds exactly the dictated words", { o: typed.outcome, r: typed.response });
      rmSync(file, { force: true });

      d.offered = false;
      const before = d.calls.length;
      const off = await run(new Scripted([plan("notes.create", { title: "Meeting" })]), SPOKEN);
      check(off.outcome !== "completed" && d.calls.length === before && /not enabled/.test(off.response), "T12 notes not enabled: no daemon call, not completed, said so", { o: off.outcome, r: off.response });
      d.offered = true;
    }

    console.log("\n[V] independent artifact check");
    {
      const f = path.join(dir, "Check.txt");
      writeFileSync(f, "exact text");
      check(verifyNoteFile(f, "Check", "exact text", dir).ok, "V1 same bytes, right name, right folder: ok");
      check(!verifyNoteFile(f, "Check", "exact text ", dir).ok && !verifyNoteFile(f, "Other", "exact text", dir).ok && !verifyNoteFile(f, "Check", "exact text", elsewhere).ok
        && !verifyNoteFile("relative.txt", "relative", "x", dir).ok && !verifyNoteFile(path.join(dir, "None.txt"), "None", "x", dir).ok,
        "V2 any difference (content, name, folder, relative path, missing file) fails");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true });
  }

  console.log("\n[H] protocol");
  {
    const hello = (tools: string[]) => JSON.stringify({ v: 1, id: "h1", op: "hello", params: { token: "t", emergencyStopped: false, stopGeneration: 0, desktop: { proto: 2, tools } } });
    let ok = false; try { ok = (parseRequest(hello(["desktop.list_windows", "notes.create"])).params as any).desktop.tools.includes("notes.create"); } catch { ok = false; }
    check(ok, "H1 the daemon may offer notes.create");
    let refused = false; try { parseRequest(hello(["notes.write_any"])); } catch { refused = true; }
    check(refused, "H2 any other notes.* name is refused");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
