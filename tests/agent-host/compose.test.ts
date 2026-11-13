/**
 * Result passing between capabilities + conversation context. Run with: npx tsx tests/agent-host/compose.test.ts
 *   G. grammar (what is a chain, what is not)   S. the second request that is built (note / memory), and refusals
 *   H. through the real AgentHost protocol with a scripted runtime: chains, follow-ups, history, fail-closed, step ids
 *   W. workflow steps: "save that ..." uses the previous step's result
 */
import { AgentHost, toTaskResult } from "../../agent/host/host";
import { parseChain, resultText, runChain, sinkObjective, textArtifact } from "../../agent/host/compose";
import { parseRequest } from "../../agent/host/protocol";
import { runWorkflow } from "../../agent/host/workflowRun";
import { requestedNote } from "../../agent/runtime/tools/notes";
import { rememberedContent } from "../../agent/runtime/tools/memory";
import { appSession } from "../../agent/runtime/tools/desktop";
import { artifactOf } from "../../agent/runtime/artifact";
import { parseKnowledgeRequest } from "../../agent/runtime/knowledge/service";
import type { RunReport, RuntimeEvent, ConversationTurn, RunOutcome } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
const report = (taskId: string, outcome: RunOutcome, response: string, verified: boolean | null = null, stepId = "s1"): RunReport => ({
  taskId, outcome, response, plan: null, iterations: 1, toolCalls: 1,
  steps: [{ step: { id: stepId, description: "", tool: "t", input: {}, dependsOn: [] }, status: outcome === "failed" ? "failed" : "succeeded", attempt: 1, outcome: { ok: true, evidence: "e" } }],
  verification: verified === null ? null : { stepsSucceeded: 1, stepsTotal: 1, criteriaSatisfied: verified, needsMoreSteps: false, missing: [], method: "evidence-only", notes: [], grounding: [{ stepId, tool: "t", status: "grounded", reason: "" }], facets: [], unexplained: [], independentlyVerified: verified },
});

async function main() {
  console.log("\n[G] Grammar");
  const c1 = parseChain("According to my research papers, how does GraphSAGE aggregate features? Then save the answer as a note called GraphSAGE notes");
  check(c1?.source === "According to my research papers, how does GraphSAGE aggregate features?" && c1.sink.kind === "note" && (c1.sink as { title: string }).title === "GraphSAGE notes", "knowledge answer -> note", c1);
  check(parseChain("Summarize report.txt and save the summary in a note titled Report summary")?.sink.kind === "note", "summary -> note");
  check(parseChain("What time is it and remember it")?.sink.kind === "memory", "any result -> memory");
  check(parseChain("save that as a note called Today")?.source === null, "follow-up: save that as a note");
  check(parseChain("Remember that.")?.source === null && parseChain("remember it")?.source === null, "follow-up: remember that / it");
  for (const no of ["Save a workflow called paper digest: According to my research papers, when is the deadline?; then save that as a note called Digest",
    "Run the workflow paper digest and remember it", "Schedule the workflow digest every day at 09:00 and remember it", "Remember that my sister is Asha", "remember that the meeting is at 5", "Create a note titled X containing \"y\"", "Save a workflow called nightly: list my workflows", "Open Notepad and type HELLO", "Index D:\\Papers as research", "save the file"])
    check(parseChain(no) === null, `not a chain: "${no}"`, parseChain(no));

  console.log("\n[S] Second request");
  const answer = 'GraphSAGE samples and aggregates features from a node\'s neighbours [1]. It uses "mean" aggregators.\nSources:\n[1] Inductive Representation Learning (p-1706.02216.pdf, p. 2)';
  const n = sinkObjective({ kind: "note", title: "GraphSAGE notes" }, textArtifact(answer, "answered"));
  check("objective" in n && requestedNote(n.objective)?.title === "GraphSAGE notes" && requestedNote(n.objective)!.text === resultText(answer, false), "note request is exactly what the notes grammar accepts, text unchanged except quotes", n);
  check("objective" in n && requestedNote(n.objective)!.text.includes("Sources:\n[1]"), "the note keeps the sources");
  const m = sinkObjective({ kind: "memory" }, textArtifact(answer, "answered"));
  check("objective" in m && rememberedContent(m.objective) === "GraphSAGE samples and aggregates features from a node's neighbours. It uses 'mean' aggregators", "memory request: the answer only, one line, no citations", m);
  check("refuse" in sinkObjective({ kind: "memory" }, textArtifact("x".repeat(1200), "answered")), "too long to remember: refused, suggests a note");
  check("refuse" in sinkObjective({ kind: "note", title: "x".repeat(70) }, textArtifact("abc", "answered")) && "refuse" in sinkObjective({ kind: "note", title: "con" }, textArtifact("abc", "answered")), "unsafe note titles refused");
  check("refuse" in sinkObjective({ kind: "memory" }, textArtifact("The wifi password is hunter22", "answered")), "a secret in the result is never remembered");
  check("refuse" in sinkObjective({ kind: "note", title: "Big" }, textArtifact("y".repeat(2100), "answered")), "too long for a note: refused");

  console.log("\n[A] Typed artifacts and more destinations");
  const pageA = { kind: "page" as const, text: "Example Domain\nThis domain is for use in illustrative examples.", sources: [{ label: "Example Domain", ref: "https://example.com/" }],
    provenance: { tool: "browser.read_page", objective: "Read https://example.com", outcome: "completed" as const, verified: true, online: true, at: "2026-11-13T10:00:00.000Z" } };
  const nA = sinkObjective({ kind: "note", title: "Example" }, pageA);
  check("objective" in nA && /Sources:\n- Example Domain \(https:\/\/example\.com\/\)/.test(requestedNote(nA.objective)!.text) && /Read from the web 2026-11-13 10:00 UTC/.test(requestedNote(nA.objective)!.text), "a note from a web page carries its URL and when it was read", nA);
  const kA = sinkObjective({ kind: "knowledge" }, pageA);
  check("objective" in kA && kA.objective === "Index the page https://example.com/ into web" && parseKnowledgeRequest(kA.objective)?.op === "index-page", "a web page result can be added to the web knowledge collection (an ordinary index request)", kA);
  check("refuse" in sinkObjective({ kind: "knowledge" }, textArtifact("some answer", "answered")), "only web pages can be added that way (files are indexed by folder)");
  const pA = sinkObjective({ kind: "notepad" }, textArtifact("GraphSAGE's \"mean\" aggregator [1].\nSources:\n[1] x", "answered"));
  const sess = "objective" in pA ? appSession(pA.objective) : null;
  check(sess?.app === "notepad" && sess.text === "GraphSAGEʼs ʺmeanʺ aggregator.", "Notepad receives one line, without citations; quotes made unambiguous; the typing card shows it exactly", { pA, sess });
  check("refuse" in sinkObjective({ kind: "notepad" }, textArtifact("z".repeat(201), "answered")), "more than 200 characters is not typed (save as a note instead)");
  check(parseChain("Read https://example.com and add it to my knowledge")?.sink.kind === "knowledge" && parseChain("According to my notes, when is the deadline? Then type it into Notepad")?.sink.kind === "notepad" && parseChain("type that into notepad")?.source === null, "chain grammar for the new destinations");
  const mA = sinkObjective({ kind: "memory" }, { ...pageA, kind: "answer", text: "The deadline is 16 November [1]." });
  check("objective" in mA && rememberedContent(mA.objective) === "The deadline is 16 November. (source: Example Domain)", "a memory keeps its single source", mA);

  const stepR = (tool: string, output: unknown, ok = true): RunReport => ({ ...report("t", "completed", "THE MODEL'S PROSE, NOT USED", true), steps: [{ step: { id: "s1", description: "", tool, input: {}, dependsOn: [] }, status: ok ? "succeeded" : "failed", attempt: 1, outcome: { ok, output, evidence: "e" } }] });
  const aPage = artifactOf(stepR("browser.read_page", { title: "Example Domain", finalUrl: "https://example.com/", text: "Body text." }), "Read https://example.com");
  check(aPage.kind === "page" && aPage.text === "Example Domain\nBody text." && aPage.provenance.online && aPage.provenance.verified === true && aPage.sources[0]!.ref === "https://example.com/", "browser.read_page -> page artifact from the tool output", aPage);
  const aSum = artifactOf(stepR("filesystem.summarize", { path: "a.txt", canonicalPath: "D:\\w\\a.txt", keySentences: [{ line: 3, text: "Budget is fixed." }] }), "Summarize a.txt");
  check(aSum.kind === "file-summary" && aSum.text === "Budget is fixed. (line 3)" && aSum.file === "D:\\w\\a.txt", "filesystem.summarize -> file-summary with line references", aSum);
  const aOcr = artifactOf(stepR("desktop.read_text", { window: { title: "Character Map", process: "charmap.exe" }, lines: [{ text: "Font:" }, { text: "Arial" }] }), "Read the text");
  check(aOcr.kind === "window-text" && aOcr.text === "Font:\nArial" && aOcr.sources[0]!.label === 'window "Character Map"', "desktop.read_text -> window-text", aOcr);
  const plug = report("t", "unverified", "Partially… [plugin note_reader 1.0.0, output not independently verified] alpha line\nNot confirmed: unmet criterion");
  plug.steps = [{ step: { id: "s1", description: "", tool: "plugin_note_reader.file_head", input: {}, dependsOn: [] }, status: "succeeded", attempt: 1, outcome: { ok: true, output: undefined, evidence: "[plugin note_reader 1.0.0, output not independently verified] alpha line\nbeta line" } }];
  const aPlug = artifactOf(plug, "Show me the first lines of docs/brief.txt");
  check(aPlug.kind === "plugin-output" && aPlug.text === "alpha line\nbeta line" && aPlug.provenance.verified === false && aPlug.sources[0]!.label === "plugin note_reader", "a plugin's own text becomes the artifact (labelled unverified), not the run's noisy response", aPlug);
  const mPlug = sinkObjective({ kind: "memory" }, aPlug);
  check("objective" in mPlug && rememberedContent(mPlug.objective) === "alpha line; beta line (source: plugin note_reader)", "plugin output -> memory keeps its source", mPlug);
  const aFail = artifactOf(stepR("browser.read_page", { title: "x", finalUrl: "https://x/", text: "y" }, false), "Read https://x");
  check(aFail.kind === "text" && aFail.provenance.online === false, "a failed tool step never becomes a typed artifact");

  console.log("\n[H] Through AgentHost");
  const lines: string[] = [];
  const calls: { objective: string; history: ConversationTurn[] }[] = [];
  const replies = new Map<string, () => RunReport>();
  const runtime = { run: async (o: { taskId: string; objective: string; history?: ConversationTurn[]; sink?: { emit(e: RuntimeEvent): void } }) => {
    calls.push({ objective: o.objective, history: o.history ?? [] });
    o.sink?.emit({ type: "plan", iteration: 1, plan: { intent: "task", goal: "g", successCriteria: [], steps: [{ id: "s1", description: "d", tool: "t", input: {}, dependsOn: [] }] } });
    o.sink?.emit({ type: "step.finished", stepId: "s1", tool: "t", status: "succeeded", durationMs: 1 });
    const key = [...replies.keys()].filter((k) => o.objective.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return key ? replies.get(key)!() : report(o.taskId, "refused", "no");
  } };
  const host = new AgentHost({ writeLine: (l) => lines.push(l), log: () => {}, token: "t".repeat(40), runtime: runtime as never, exit: () => {} });
  host.handleLine(JSON.stringify({ v: 1, id: "h", op: "hello", params: { token: "t".repeat(40), emergencyStopped: false, stopGeneration: 0 } }));
  let n2 = 0;
  const submit = async (objective: string) => {
    const taskId = `t${++n2}`;
    host.handleLine(JSON.stringify({ v: 1, id: `r${n2}`, op: "submit", params: { taskId, objective } }));
    for (let i = 0; i < 200; i++) {
      const fin = lines.map((l) => JSON.parse(l)).find((m) => m.kind === "event" && m.event === "task.finished" && m.taskId === taskId);
      if (fin) return { result: fin.data, events: lines.map((l) => JSON.parse(l)).filter((m) => m.kind === "event" && m.taskId === taskId) };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no result");
  };
  replies.set("According to my research papers", () => report("x", "answered", answer, null, "kb-answer"));
  replies.set("Create a note titled", () => report("x", "completed", "Created the note GraphSAGE notes.", true));
  replies.set("Remember that", () => report("x", "completed", "Remembered.", true));
  replies.set("What time is it", () => report("x", "completed", "It is 10:42.", true));
  replies.set("Delete my notes", () => report("x", "refused", "I can't delete notes."));

  let r = await submit("According to my research papers, how does GraphSAGE aggregate? Then save the answer as a note called GraphSAGE notes");
  check(calls.length === 2 && calls[0]!.objective === "According to my research papers, how does GraphSAGE aggregate?" && requestedNote(calls[1]!.objective)?.title === "GraphSAGE notes", "chain: the first part, then the note request built from its result", calls.map((c) => c.objective.slice(0, 60)));
  check(r.result.outcome === "unverified" && /Saved the result of .* as note "GraphSAGE notes" \(checked/.test(r.result.response) && r.result.response.startsWith("GraphSAGE samples"), "chain result: the answer, then what was saved (answered + saved -> unverified overall)", r.result);
  check(r.result.steps.map((s: { id: string }) => s.id).join() === "kb-answer,save.s1" && r.events.some((e) => e.data?.type === "step.finished" && e.data.stepId === "save.s1"), "step ids of the second part are prefixed in the result AND in progress", r.result.steps);
  check(calls[1]!.history.length === 0, "no history yet for the first task");

  // Found in the real HUD: an answer whose source line says "§ Project notes > Schedule" was sent through workflow-management routing and refused
  // ("one workflow operation per request"). The saving request must go straight to the runtime.
  replies.set("According to my notes", () => report("x", "answered", "The deadline is 16 November 2026 [1].\nSources:\n[1] Project notes (project-notes.md, lines 5-5, § Project notes > Schedule)", null, "kb-answer"));
  const before = calls.length;
  r = await submit("According to my notes, when is the deadline? Then save the answer as a note called Deadline answer");
  check(calls.length === before + 2 && requestedNote(calls.at(-1)!.objective)?.title === "Deadline answer" && /Schedule/.test(calls.at(-1)!.objective) && /Saved the result/.test(r.result.response), "a saved answer that mentions a schedule is still saved as a note (never read as a workflow request)", { calls: calls.slice(before).map((c) => c.objective.slice(0, 50)), response: r.result.response.slice(-160) });

  r = await submit("Remember that");
  check(r.result.outcome === "completed" && calls.at(-1)!.objective === "Remember that The deadline is 16 November 2026." && calls.at(-1)!.history.length === 2, "follow-up 'remember that' uses the previous result; history now passed", { o: calls.at(-1)!.objective, h: calls.at(-1)!.history.length });

  r = await submit("Delete my notes and remember it");
  check(r.result.outcome === "refused" && /Nothing was passed on/.test(r.result.response) && !calls.at(-1)!.objective.startsWith("Remember that I can"), "fail-closed: a refused first part saves nothing", r.result);
  r = await submit("save that as a note called After refusal");
  check(r.result.outcome === "refused" && /ended REFUSED/.test(r.result.response), "follow-up after a refusal: nothing to save");

  r = await submit("What time is it?");
  check(calls.at(-1)!.history.map((h) => h.objective).join("|").includes("Delete my notes and remember it") && calls.at(-1)!.history.length <= 5, "history carries the last turns (at most 5) to the planner", calls.at(-1)!.history.map((h) => h.objective));
  replies.set("Create a note titled Time", () => report("x", "failed", "The daemon refused the note.", false));
  r = await submit("save that as a note called Time");
  check(r.result.outcome === "failed" && /NOT saved/.test(r.result.response), "a failed save is reported as not saved", r.result.response);

  console.log("\n[P] The host accepts the FULL product offer (found in the real HUD: the host refused to start with every feature on)");
  {
    const full = ["desktop.list_windows", "desktop.inspect_window", "desktop.request_action", "desktop.read_text", "desktop.launch_app", "desktop.type_text", "desktop.press_keys", "desktop.click", "desktop.focus_window",
      "browser.request_action", "files.organize", "files.undo_organize", "files.copy", "files.rename", "files.undo_copy_rename", "notes.create",
      "workflows.save", "workflows.list", "workflows.get", "workflows.delete", "workflows.schedule", "workflows.unschedule",
      "plugins.list", "plugins.approve", "plugins.revoke", "plugins.grant", "plugins.revoke_permission", "plugins.disable", "plugins.enable",
      "desktop.minimize_window", "desktop.maximize_window", "desktop.restore_window", "desktop.close_window", "desktop.scroll"];
    const hello = (tools: string[]) => JSON.stringify({ v: 1, id: "h", op: "hello", params: { token: "t".repeat(40), emergencyStopped: false, stopGeneration: 0, desktop: { proto: 2, tools } } });
    let ok = true; try { parseRequest(hello(full)); } catch { ok = false; }
    check(ok && full.length > 32, `a hello offering all ${full.length} product tools is accepted`);
    let bad = false; try { parseRequest(hello([...full, "shell.exec"])); } catch { bad = true; }
    check(bad, "an unknown tool name is still refused");
    let many = false; try { parseRequest(hello(Array.from({ length: 65 }, (_, i) => `desktop.t${i}`))); } catch { many = true; }
    check(many, "more than 64 names is still refused");
  }

  console.log("\n[E] Emergency Stop between the parts of a chain");
  {
    const ac = new AbortController();
    const runs: string[] = [];
    const chainRun = (o: string) => { runs.push(o); ac.abort(); return Promise.resolve(toTaskResult(report("e1", "answered", "The answer is 42 [1].\nSources:\n[1] x"))); };
    const out = await runChain({ source: "According to my notes, what is the answer?", sink: { kind: "note", title: "Answer" } }, { taskId: "e1", previous: null, signal: ac.signal, run: chainRun });
    check(out.outcome === "cancelled" && runs.length === 1 && /Stopped before passing the result on/.test(out.response), "a stop after the first part starts nothing more (the note request is never made)", { out: out.outcome, runs });
  }

  console.log("\n[W] Workflow steps");
  const wfCalls: string[] = [];
  const wfRuntime = { run: async (o: { taskId: string; objective: string }) => { wfCalls.push(o.objective); return o.objective.startsWith("Summarize") ? report(o.taskId, "completed", "Summary: three key points.", true) : report(o.taskId, "completed", "ok", true); } };
  const bridge = { available: true, offers: () => true, call: async () => ({ status: "ok", result: { name: "digest", steps: ["Summarize notes.txt", "save that as a note called Digest"] } }) };
  const wr = await runWorkflow("digest", { runtime: wfRuntime as never, desktop: bridge as never }, "w1", new AbortController().signal, () => {});
  check(wr.outcome === "completed" && wfCalls[1] === 'Create a note titled Digest containing "Summary: three key points."' && wr.steps.map((s) => s.id).join() === "w1_s1,w2_save.s1", "a workflow step saves the previous step's result through the normal note request", { wfCalls, steps: wr.steps.map((s) => s.id) });
  void toTaskResult;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
