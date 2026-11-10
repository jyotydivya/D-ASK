/**
 * The native HUD transport for agent tasks: correlation, ordering, errors and honesty of what is shown.
 * Run with: npx tsx tests/hud-agent/native-agent.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  CONNECTION_LOST_MESSAGE, MAX_OBJECTIVE_CHARS, NativeAgentClient, SUBMIT_REPLY_TIMEOUT_MS,
  progressToEvent, rejectionMessage, toNativeResult, type NativeTaskResult,
} from "../../hooks/nativeAgent";
import { applyNodeEvent, reduceNativeResult, reduceTaskEvent, type TaskState } from "../../hooks/useTask";
import type { TaskEvent } from "../../agent/types";

let passed = 0;
let failed = 0;
function check(ok: unknown, name: string, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

function harness() {
  const posted: any[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let nextId = 1;
  const log = {
    accepted: [] as string[],
    events: [] as TaskEvent[],
    finished: [] as { taskId: string | null; result: NativeTaskResult }[],
    cancelling: [] as string[],
    cancelFailed: [] as string[],
  };
  const client = new NativeAgentClient(
    {
      post: (m) => posted.push(m),
      newId: () => `req${nextId++}`,
      setTimer: (fn) => { const h = nextTimer++; timers.set(h, fn); return h; },
      clearTimer: (h) => { timers.delete(h as number); },
      now: () => new Date(0),
    },
    {
      onAccepted: (t) => log.accepted.push(t),
      onEvent: (_t, e) => log.events.push(e),
      onFinished: (taskId, result) => log.finished.push({ taskId, result }),
      onCancelling: (t) => log.cancelling.push(t),
      onCancelFailed: (t) => log.cancelFailed.push(t),
    },
  );
  return { client, posted, timers, log };
}

const accepted = (replyToId: string, taskId: string) => ({ type: "AgentTaskSubmitResponse", replyToId, payload: { accepted: true, taskId } });
const progress = (taskId: string, seq: number, data: unknown) => ({ type: "AgentTaskProgressNotification", replyToId: null, payload: { taskId, seq, data } });
const finished = (taskId: string, extra: object = {}) => ({ type: "AgentTaskResultNotification", replyToId: null, payload: { taskId, outcome: "completed", response: "Done.", ...extra } });

console.log("submit");
{
  const h = harness();
  h.client.submit("  What is 2+2?  ");
  check(h.posted.length === 1 && h.posted[0].type === "AgentTaskSubmit", "posts one AgentTaskSubmit");
  check(JSON.stringify(Object.keys(h.posted[0].payload).sort()) === '["objective","request_id"]', "the payload holds only a request id and the objective", h.posted[0].payload);
  check(h.posted[0].payload.objective === "What is 2+2?", "the objective is trimmed");
  check(h.client.isBusy, "busy while the reply is pending");
  h.client.handleMessage(accepted("req1", "t1"));
  check(h.log.accepted[0] === "t1" && h.client.activeTaskId === "t1", "the matching reply makes the task active");
  check(h.timers.size === 0, "the reply timer is cleared");
}
{
  const h = harness();
  h.client.submit("x");
  h.client.submit("y");
  check(h.posted.length === 1, "a second submit while one is pending is not sent");
  check(h.log.finished[0]?.result.errorCode === "busy", "and is reported as busy", h.log.finished[0]);
}
{
  const h = harness();
  h.client.submit("   ");
  h.client.submit("a".repeat(MAX_OBJECTIVE_CHARS + 1));
  check(h.posted.length === 0, "empty and oversized requests are not sent");
  check(h.log.finished.every((f) => f.result.errorCode === "invalid_request"), "and are reported as invalid");
}

console.log("rejections");
for (const code of ["agent_host_disabled", "host_unavailable", "emergency_stopped", "busy", "invalid_request", "daemon_model_busy", "daemon_unavailable"]) {
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage({ type: "AgentTaskSubmitResponse", replyToId: "req1", payload: { accepted: false, taskId: null, rejectionCode: code, errorMessage: "raw" } });
  const f = h.log.finished[0];
  check(f?.taskId === null && f.result.errorCode === code && f.result.outcome !== "completed", `${code} ends the request, not as completed`, f);
  check(f?.result.response === rejectionMessage(code) && f.result.response !== "raw", `${code} has a user-facing message`);
  check(!h.client.isBusy, `${code} leaves the client free`);
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage({ type: "AgentTaskSubmitResponse", replyToId: "req1", payload: { accepted: false, rejectionCode: "something_new", errorMessage: "Daemon says no." } });
  check(h.log.finished[0]?.result.response === "Daemon says no.", "an unknown rejection shows the daemon's message");
}

console.log("correlation and ordering");
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(accepted("other-request", "t9"));
  check(!h.client.activeTaskId, "a reply to another request is not taken as ours");
  check(h.posted.some((p) => p.type === "AgentTaskCancel" && p.payload.task_id === "t9"), "an accepted task nobody is waiting for is cancelled, not left running", h.posted);
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(progress("t1", 1, { type: "phase", phase: "planning" }));
  h.client.handleMessage(progress("t1", 2, { type: "phase", phase: "executing" }));
  check(h.log.events.length === 0, "progress that overtakes the submit reply is held");
  h.client.handleMessage(accepted("req1", "t1"));
  check(h.log.events.length === 2, "and applied once the task id is known", h.log.events.length);
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(finished("t1"));
  h.client.handleMessage(accepted("req1", "t1"));
  check(h.log.finished[0]?.taskId === "t1" && !h.client.isBusy, "a very fast result that overtakes the reply is still delivered");
}
{
  const h = harness();
  h.client.handleMessage(progress("t1", 1, { type: "phase", phase: "planning" }));
  h.client.handleMessage(finished("t1"));
  check(h.log.events.length === 0 && h.log.finished.length === 0, "messages for a task this client did not start are ignored");
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(accepted("req1", "t1"));
  h.client.handleMessage(progress("t2", 1, { type: "phase", phase: "planning" }));
  h.client.handleMessage(finished("t2"));
  check(h.log.events.length === 0 && h.log.finished.length === 0 && h.client.activeTaskId === "t1", "another task's messages do not touch the active task");
  h.client.handleMessage(progress("t1", 2, { type: "phase", phase: "planning" }));
  h.client.handleMessage(progress("t1", 2, { type: "phase", phase: "executing" }));
  h.client.handleMessage(progress("t1", 1, { type: "phase", phase: "verifying" }));
  check(h.log.events.length === 1, "repeated or older sequence numbers are dropped", h.log.events.length);
}

console.log("no reply");
{
  const h = harness();
  h.client.submit("x");
  const timer = [...h.timers.values()][0]!;
  check(SUBMIT_REPLY_TIMEOUT_MS >= 15_000, "the timeout allows for the host's start-up");
  timer();
  check(h.log.finished[0]?.result.errorCode === "no_reply" && !h.client.isBusy, "no reply ends the request without claiming a result");
  h.client.handleMessage(accepted("req1", "t5"));
  check(h.posted.some((p) => p.type === "AgentTaskCancel" && p.payload.task_id === "t5"), "a late acceptance after the timeout is cancelled");
  check(h.log.finished.length === 1 && !h.client.activeTaskId, "and does not resurrect the request");
}

console.log("cancel");
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(accepted("req1", "t1"));
  h.client.cancel();
  const c = h.posted.at(-1);
  check(c.type === "AgentTaskCancel" && c.payload.task_id === "t1", "cancel names the active task");
  check(JSON.stringify(Object.keys(c.payload).sort()) === '["request_id","task_id"]', "and carries nothing else", c.payload);
  check(h.client.activeTaskId === "t1", "the task stays active until the daemon reports its end");
  h.client.handleMessage({ type: "AgentTaskCancelResponse", replyToId: "req2", payload: { taskId: "t1", cancelling: true } });
  check(h.log.cancelling[0] === "t1", "the daemon's acknowledgement is reported");
  h.client.handleMessage(finished("t1", { outcome: "cancelled", response: "Stopped." }));
  check(h.log.finished[0]?.result.outcome === "cancelled" && !h.client.isBusy, "the outcome is what the daemon reported");
}
{
  const h = harness();
  h.client.submit("x");
  h.client.cancel();
  check(!h.posted.some((p) => p.type === "AgentTaskCancel"), "cancel before the task has an id waits");
  h.client.handleMessage(accepted("req1", "t1"));
  check(h.posted.some((p) => p.type === "AgentTaskCancel" && p.payload.task_id === "t1"), "and is sent as soon as it does");
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(accepted("req1", "t1"));
  h.client.handleMessage({ type: "AgentTaskCancelResponse", payload: { taskId: "t1", cancelling: false, rejectionCode: "host_unavailable" } });
  check(h.log.cancelFailed[0] === "t1" && h.client.activeTaskId === "t1", "a refused cancel is reported and does not pretend the task ended");
  const h2 = harness();
  h2.client.submit("x");
  h2.client.handleMessage(accepted("req1", "t1"));
  h2.client.handleMessage({ type: "AgentTaskCancelResponse", payload: { taskId: "t1", cancelling: false, rejectionCode: "already_finished" } });
  check(h2.log.cancelFailed.length === 0, "already_finished is not reported as a failure");
}

console.log("connection loss");
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage(accepted("req1", "t1"));
  h.client.handleMessage({ type: "AgentConnection", payload: { connected: true, emergencyStopped: false } });
  check(h.client.activeTaskId === "t1", "a connected report changes nothing");
  h.client.handleMessage({ type: "AgentConnection", payload: { connected: false, emergencyStopped: false } });
  const f = h.log.finished[0];
  check(f?.taskId === "t1" && f.result.outcome === "failed" && f.result.interrupted, "a lost connection ends a running task as interrupted, never completed", f);
  check(f?.result.response === CONNECTION_LOST_MESSAGE && /not retried/.test(f.result.response) && /may have taken effect/.test(f.result.response), "and says it wasn't retried and may have had effects");
  check(!h.posted.slice(1).some((p) => p.type === "AgentTaskSubmit"), "nothing is resubmitted");
  h.client.handleMessage({ type: "AgentConnection", payload: { connected: true, emergencyStopped: false } });
  check(h.posted.filter((p) => p.type === "AgentTaskSubmit").length === 1, "not even after reconnecting");
}
{
  const h = harness();
  h.client.submit("x");
  h.client.handleMessage({ type: "AgentConnection", payload: { connected: false } });
  check(h.log.finished[0]?.result.errorCode === "daemon_connection_lost" && !h.client.isBusy && h.timers.size === 0, "a pending submit also ends on connection loss");
}

console.log("interrupted and malformed results");
{
  const r = toNativeResult({ taskId: "t", outcome: "failed", response: "x", interrupted: true, errorCode: "host_crashed", steps: null, verification: null });
  check(r.interrupted && r.errorCode === "host_crashed" && r.independentlyVerified === null, "an interrupted result keeps its facts", r);
  const empty = toNativeResult({});
  check(empty.outcome === "failed", "a result with no outcome is a failure, not a success");
  check(toNativeResult(null).outcome === "failed", "so is a result that isn't an object");
  const v = toNativeResult({ outcome: "completed", response: "ok", verification: { independentlyVerified: true } });
  check(v.independentlyVerified === true, "verification is passed through");
  const notV = toNativeResult({ outcome: "completed", response: "ok" });
  check(notV.independentlyVerified === null, "no report never reads as verified");
  const fake = toNativeResult({ outcome: "completed", verification: { independentlyVerified: "yes" } });
  check(fake.independentlyVerified === null, "a non-boolean verification value is not believed");
}

console.log("panel state");
const base: TaskState = { task: null, nodes: [], events: [], artifacts: [], pendingApproval: null, orbState: "understanding", isActive: true, progressPct: 0, lastMessage: "", result: null };
{
  const plan = progressToEvent("t1", 1, { type: "plan", iteration: 1, intent: "action", goal: "g", tools: ["math.evaluate"], stepIds: ["s1"] }, new Date(0))!;
  let st = reduceTaskEvent(base, plan, "t1");
  check(st.nodes.length === 1 && st.nodes[0]!.id === "s1" && st.nodes[0]!.status === "pending", "a plan creates the step list", st.nodes);
  st = reduceTaskEvent(st, progressToEvent("t1", 2, { type: "step.started", stepId: "s1", tool: "math.evaluate" }, new Date(0))!, "t1");
  check(st.nodes[0]!.status === "running", "step.started marks it running");
  const mid = st;
  st = reduceTaskEvent(st, progressToEvent("t1", 3, { type: "step.finished", stepId: "s1", tool: "math.evaluate", status: "succeeded", durationMs: 1 }, new Date(0))!, "t1");
  check(st.nodes[0]!.status === "completed", "step.finished marks it completed");
  st = reduceNativeResult(st, toNativeResult({ outcome: "completed", response: "Done.\n• (17+25)*2 = 84", verification: { independentlyVerified: true }, steps: [{ id: "s1", status: "succeeded", evidence: "(17+25)*2 = 84" }] }));
  check(!st.isActive && st.orbState === "completed" && st.result?.independentlyVerified === true, "a verified completion shows as verified", st.result);
  check((st.nodes[0]!.result as { evidence?: string }).evidence === "(17+25)*2 = 84", "the evidence comes from the daemon's report");

  const stopped = reduceNativeResult(mid, toNativeResult({ outcome: "cancelled", response: "Stopped.", steps: [] }));
  check(stopped.orbState === "standby" && stopped.nodes[0]!.status === "skipped", "a step still running when the task ends can't stay spinning", stopped.nodes[0]);
  check(stopped.result?.outcome === "cancelled", "the cancelled outcome is shown as cancelled");

  for (const outcome of ["unverified", "partial", "refused", "failed"]) {
    const s = reduceNativeResult(mid, toNativeResult({ outcome, response: "r", verification: { independentlyVerified: false } }));
    check(s.orbState !== "completed" && s.result?.outcome === outcome, `${outcome} is never shown as completed`, s.orbState);
    check(s.result?.independentlyVerified === false, `${outcome} keeps its verification status`);
  }
}
{
  for (const [data, expected] of [
    [{ type: "phase", phase: "planning" }, "task.status_changed"],
    [{ type: "approval.denied", stepId: "s", tool: "x" }, "tool.failed"],
    [{ type: "verification", independentlyVerified: false }, "verification.completed"],
    [{ type: "step.finished", stepId: "s", tool: "x", status: "failed" }, "node.failed"],
  ] as const) {
    check(progressToEvent("t", 1, data, new Date(0))?.type === expected, `${data.type} maps to ${expected}`);
  }
  check(progressToEvent("t", 1, { type: "tool.spy", input: "secret" }, new Date(0)) === null, "unknown progress is dropped");
  const denied = progressToEvent("t", 1, { type: "approval.denied", stepId: "s", tool: "x" }, new Date(0))!;
  check(applyNodeEvent([], denied, "t").length === 0, "an approval denial cannot create or approve a step");
}

console.log("source checks");
{
  const root = path.resolve(__dirname, "..", "..");
  const native = fs.readFileSync(path.join(root, "hooks/nativeAgent.ts"), "utf8");
  const task = fs.readFileSync(path.join(root, "hooks/useTask.ts"), "utf8");
  check(!/\bfetch\s*\(/.test(native), "the native transport has no HTTP path");
  check(/fetch\("\/api\/tasks"/.test(task) && /new EventSource\(/.test(task), "the browser HTTP transport is still in place");
  const bridge = fs.readFileSync(path.join(root, "src/hud-native/src/main.rs"), "utf8");
  check(!/Frontend raw message/.test(bridge) && !bridge.includes("invalid bridge message: {}"), "the HUD log never holds raw bridge messages");
  check(!/D-ASK ONLINE/.test(bridge), "the canned assistant reply is gone from the HUD");
  const orb = fs.readFileSync(path.join(root, "components/JarvisOrb.tsx"), "utf8");
  const stopButton = orb.slice(orb.indexOf("isEmergencyStopped ? handleResumeExecution"), orb.indexOf("isEmergencyStopped ? handleResumeExecution") + 400);
  check(/pointerEvents:\s*"auto"/.test(stopButton), "the STOP button takes clicks even though its header has pointer-events: none");
  check(/payload\?\.success === false/.test(orb), "a refused resume does not clear the HUD's stopped state");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
