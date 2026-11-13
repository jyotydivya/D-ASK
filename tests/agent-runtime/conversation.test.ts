/**
 * Conversation path: informational questions vs computer actions vs unsupported requests.
 * Run with: npx tsx tests/agent-runtime/conversation.test.ts
 *
 * Scripted model (no network); everything else is real: the gate (classifyConversation), Planner, Verifier, grounding, registry,
 * AgentRuntime. Distinguishes (1) an informational question answered by the model, (2) a question a tool answers and verifies,
 * (3) an action that must NOT be answered conversationally, (4) an unsupported request, (5) a plausible answer without evidence.
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime";
import { acceptAnswer, classifyConversation } from "../../agent/runtime/conversation";
import { extractExpressions, normalizeMathText, parseNumberWords } from "../../agent/runtime/tools/requestChecks";
import { evaluateArithmetic } from "../../agent/runtime/tools/builtin";
import { outcomeLabel, reduceNativeResult, type TaskState } from "../../hooks/useTask";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");

type Scripted = unknown | Error;
class Model implements LanguageModel {
  readonly name = "scripted";
  calls: StructuredRequest[] = [];
  constructor(private q: { plan?: Scripted[]; assess?: Scripted[]; answer?: Scripted[] } = {}) {}
  async generateJson(req: StructuredRequest): Promise<unknown> {
    this.calls.push(req);
    const queue = (req.purpose === "plan" ? this.q.plan : req.purpose === "assess" ? this.q.assess : this.q.answer) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error(`no scripted ${req.purpose} response`);
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
  n(purpose: StructuredRequest["purpose"]) { return this.calls.filter((c) => c.purpose === purpose).length; }
}
const satisfied = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "evidence shows it" };
const mathPlan = (expr: string) => ({ intent: "question", goal: "evaluate", successCriteria: ["the value is shown"], steps: [{ id: "s1", description: "evaluate", tool: "math.evaluate", input: { expression: expr } }] });
const unsupportedPlan = { intent: "unsupported", goal: "x", successCriteria: [], steps: [], refusalReason: "No tool does that." };
const registry = () => createDefaultRegistry(ROOT);
const rt = (model: LanguageModel, conversation: boolean) => new AgentRuntime({ model, registry: registry(), granted: DEFAULT_GRANTS, conversation });
let n = 0;
const run = (r: AgentRuntime, objective: string) => r.run({ taskId: `t${++n}`, objective });

async function main() {
  const reg = registry();

  console.log("[A] number words (the failed voice question)");
  const ev = (s: string) => evaluateArithmetic(s);
  check(JSON.stringify(extractExpressions("What is seven times eight?", ev)) === '[{"expression":"7*8","value":56}]', "A1 'seven times eight' is the request's own arithmetic");
  check(extractExpressions("WHAT IS SEVEN TIMES EIGHT", ev)[0]?.value === 56, "A2 the HUD's upper-case transcript works");
  check(extractExpressions("what is twenty one plus thirty-four", ev)[0]?.expression === "21+34", "A3 compound numbers");
  check(extractExpressions("what is one hundred and five minus five", ev)[0]?.value === 100, "A4 hundreds");
  check(extractExpressions("what is two thousand divided by four", ev)[0]?.value === 500, "A5 thousands");
  check(extractExpressions("what is seven", ev).length === 0 && extractExpressions("What is 7 times 8?", ev)[0]?.value === 56, "A6 a lone number word is no expression; digits still work");
  check(parseNumberWords("one one") === null && parseNumberWords("twenty thirty") === null && parseNumberWords("twenty one") === 21, "A7 malformed number-word runs are never guessed");
  check(normalizeMathText("What is ten minus three").includes("10 - 3"), "A8 normalisation");

  console.log("[B] the gate: informational vs action vs tool-served");
  const yes = ["What is the capital of France?", "Who wrote Hamlet?", "Why is the sky blue?", "Explain photosynthesis", "Tell me about the Roman Empire",
    "How does a rainbow form?", "Is Paris in France?", "Can you tell me what an API is?", "Define entropy", "tell me what a noun is"];
  for (const q of yes) check(classifyConversation(reg, q).conversational, `B1 conversational: ${q}`, classifyConversation(reg, q));
  const no: [string, string][] = [
    ["What is seven times eight?", "a tool serves part of it"], ["What is 7 times 8?", "a tool serves part of it"], ["What time is it?", "tool"],
    ["What is my favourite editor?", "my"], ["How much memory is free?", "state"], ["What is the weather in Pune?", "weather"],
    ["Delete my files", "not phrased"], ["Open notepad", "not phrased"], ["Can you open notepad?", "not phrased"],
    ["What is in D:\\notes\\todo.txt?", "path"], ["What is the latest news?", "current"], ["Tell me a joke", "me a"],
    ["What is a CPU and delete the temp folder", "action"], ["Summarize the report", "not phrased"], ["What is on my screen?", "my"],
    ["Who is the president of the United States?", "current"], ["Send an email to Sam", "not phrased"], ["how many files are in this folder", "state"], ["What", "length"]];
  for (const [q] of no) check(!classifyConversation(reg, q).conversational, `B2 not conversational: ${q}`, classifyConversation(reg, q));

  console.log("[C] acceptAnswer");
  check(acceptAnswer({ answer: "Paris is the capital of France." }).ok === true, "C1 a plain answer is accepted");
  check((acceptAnswer({ answer: "**Paris** is `the` capital" }) as { text: string }).text === "Paris is the capital", "C2 markup is stripped for speech");
  check(!acceptAnswer({ answer: "   " }).ok && !acceptAnswer({}).ok && !acceptAnswer(null).ok, "C3 empty or malformed is refused");
  check(!acceptAnswer({ answer: "I have opened Notepad for you." }).ok && !acceptAnswer({ answer: "I searched the web and found it." }).ok, "C4 a claimed action is discarded");
  check(acceptAnswer({ answer: "I'm not sure about that." }).ok === true, "C5 'I don't know' is a valid answer");
  check(!acceptAnswer({ answer: "x".repeat(601) }).ok, "C6 over-long answers are refused");

  console.log("[D] runtime: an informational question is answered, not 'completed'");
  {
    const m = new Model({ answer: [{ answer: "The capital of France is Paris." }] });
    const r = await run(rt(m, true), "What is the capital of France?");
    check(r.outcome === "answered" && r.response === "The capital of France is Paris.", "D1 answered with the model's answer as the response", { o: r.outcome, r: r.response });
    check(m.n("plan") === 0 && m.n("assess") === 0 && m.n("answer") === 1 && r.toolCalls === 0 && r.steps.length === 0, "D2 no planner, no verifier, no tool: one answer call");
    check(r.verification === null, "D3 no verification is claimed (nothing was checked against a source)");
    check(/no tools, no internet/i.test(m.calls[0].system) && /<user_question>/.test(m.calls[0].user), "D4 the model is told it has no tools and the question is fenced as data");
  }
  {
    const m = new Model({ plan: [unsupportedPlan], answer: [{ answer: "Paris." }] });
    const r = await run(rt(m, false), "What is the capital of France?");
    check(r.outcome === "refused" && m.n("answer") === 0, "D5 with the feature off the old behaviour is unchanged (refused, no answer call)", r.outcome);
  }
  {
    const m = new Model({ answer: [{ answer: "I have opened Notepad and typed it for you." }] });
    const r = await run(rt(m, true), "What is the capital of France?");
    check(r.outcome === "failed" && /claimed an action/.test(r.response), "D6 an answer that claims an action is discarded with a clear message", r);
  }
  {
    const m = new Model({ answer: [new Error("model offline")] });
    const r = await run(rt(m, true), "Why is the sky blue?");
    check(r.outcome === "failed" && /couldn't reach the local model/.test(r.response) && /model offline/.test(r.response), "D7 a model failure is explained, not hidden", r.response);
  }

  console.log("[E] runtime: actions and unsupported requests never take the conversation path");
  for (const q of ["Delete my notes", "Open notepad", "Can you open notepad?", "Send an email to Sam", "What is the weather in Pune?", "What is my favourite editor?"]) {
    const m = new Model({ plan: [unsupportedPlan], answer: [{ answer: "Sure, done." }] });
    const r = await run(rt(m, true), q);
    check(m.n("answer") === 0 && r.outcome !== "answered" && r.outcome !== "completed", `E1 not answered conversationally: ${q}`, { o: r.outcome, answers: m.n("answer") });
    check(m.n("plan") >= 1, `E1b went to the planner: ${q}`);
  }

  console.log("[F] runtime: a question a tool answers is verified, spoken numbers included");
  {
    const m = new Model({ plan: [mathPlan("7 * 8")], assess: [satisfied] });
    const r = await run(rt(m, true), "What is seven times eight?");
    check(r.outcome === "completed" && r.verification?.independentlyVerified === true && /56/.test(r.response), "F1 'What is seven times eight?' → completed, independently verified, 56", { o: r.outcome, v: r.verification?.independentlyVerified, r: r.response });
    check(m.n("answer") === 0 && r.toolCalls === 1, "F2 the tool computed it; the conversation path was not used");
  }
  {
    const m = new Model({ plan: [mathPlan("7*8")], assess: [satisfied] });
    const r = await run(rt(m, true), "What is 7 times 8?");
    check(r.outcome === "completed" && r.verification?.independentlyVerified === true, "F3 the digit form still completes", r.outcome);
  }
  {
    const m = new Model({ plan: [mathPlan("7 * 9")], assess: [satisfied] });
    const r = await run(rt(m, true), "What is seven times eight?");
    check(r.outcome !== "completed" && !/56/.test(r.response) || r.outcome === "failed", "F4 a plan with the WRONG numbers is not completed", { o: r.outcome, r: r.response });
  }
  {
    const m = new Model({ plan: [mathPlan("7 * 8")], assess: [satisfied] });
    const r = await run(rt(m, true), "What is seven times eight in hexadecimal?");
    check(r.outcome === "unverified" && r.verification?.independentlyVerified === false, "F5 plausible answer with an unexplained part stays 'unverified' (verifier strictness unchanged)", { o: r.outcome, un: r.verification?.unexplained });
  }
  {
    const m = new Model({ plan: [mathPlan("7 * 8")], assess: [satisfied] });
    const r = await run(rt(m, true), "What is seven times eight and email it to Sam?");
    check(r.outcome !== "completed" && r.outcome !== "answered", "F6 a request that mixes a question with an action is never completed or answered", r.outcome);
  }

  console.log("[G] HUD labels");
  check(outcomeLabel("answered") === "✓ Answered" && outcomeLabel("unverified").includes("not confirmed"), "G1 labels");
  const base = { orbState: "standby", isActive: true, nodes: [], events: [], lastMessage: "", progressPct: 0, taskId: "t", result: null } as unknown as TaskState;
  const s = reduceNativeResult(base, { outcome: "answered", response: "56", independentlyVerified: null, interrupted: false, errorCode: null, steps: [] });
  check(s.result?.outcome === "answered" && s.result?.response === "56" && s.orbState === "completed" && s.isActive === false, "G2 the HUD state carries the answered outcome and the actual answer", s.result);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
