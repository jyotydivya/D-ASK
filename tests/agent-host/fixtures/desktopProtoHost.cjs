// TEST-ONLY host for the daemon's protocol v2 (read-only desktop calls). It speaks v1 for hello/submit, then, for
// each submitted task, plays a script of raw v2 lines from DASK_DESKTOP_SCRIPT and reports every daemon reply it got
// back as the task's response (outcome "unverified"), so the daemon tests can assert exactly what was answered.
//
//   DASK_DESKTOP_HELLO   echo (default) | none | claim-extra   — what the hello result says about desktop
//   DASK_DESKTOP_SCRIPT  JSON array of steps: {"line": {...}} (taskId "$TASK" is substituted), {"raw": "text"},
//                        {"sleep": ms}, {"await": n} (wait until n replies have arrived), {"exit": code}
//   DASK_DESKTOP_SETTLE  ms to wait for late replies before finishing (default 300)
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const helloMode = process.env.DASK_DESKTOP_HELLO || "echo";
const script = JSON.parse(process.env.DASK_DESKTOP_SCRIPT || "[]");
const settle = Number(process.env.DASK_DESKTOP_SETTLE || 300);
const replies = [];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(taskId, requestId) {
  for (const step of script) {
    if (step.sleep) await sleep(step.sleep);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.raw !== undefined) process.stdout.write(step.raw + "\n");
    else if (step.await !== undefined) { const until = Date.now() + 8000; while (replies.length < step.await && Date.now() < until) await sleep(10); }
    else if (step.line) send(JSON.parse(JSON.stringify(step.line).split("$TASK").join(taskId)));
  }
  await sleep(settle);
  send({ v: 1, kind: "event", event: "task.finished", requestId, taskId, seq: 1, data: { outcome: "unverified", response: JSON.stringify(replies), iterations: 0, toolCalls: 0, error: null, steps: [], verification: null } });
}

function handle(m) {
  if (m.kind === "reply") { replies.push(m); return; }
  if (m.op === "hello") {
    const result = { protocol: 1, ready: true, model: null };
    const offer = m.params.desktop;
    if (helloMode === "echo" && offer) result.desktop = offer;
    if (helloMode === "claim-extra" && offer) result.desktop = { proto: 2, tools: [...offer.tools, "desktop.click"] };
    send({ v: 1, kind: "response", id: m.id, ok: true, result });
    return;
  }
  if (m.op === "submit") {
    send({ v: 1, kind: "response", id: m.id, ok: true, result: { accepted: true, taskId: m.params.taskId } });
    void play(m.params.taskId, m.id);
    return;
  }
  send({ v: 1, kind: "response", id: m.id, ok: true, result: { ready: true, model: null } });
}
setInterval(() => {}, 1 << 30);
