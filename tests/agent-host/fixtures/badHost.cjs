// TEST-ONLY misbehaving host, for the daemon's fail-closed handling. Mode from DASK_BAD_HOST_MODE.
//   exit-immediately   dies at startup
//   never-ready        reads stdin but never answers
//   stdout-noise       answers hello, then writes a non-JSON line on stdout
//   wrong-id           answers hello, then sends a response to a request that was never made
//   forged-event       answers hello, then sends an event for a task it was never given
//   bad-outcome        accepts a task, then reports a nonsense outcome
//   mute-after-hello   answers hello, then ignores everything (hung, ignores Emergency Stop)
//   refuse-hello       answers hello with not-ready
const mode = process.env.DASK_BAD_HOST_MODE;
if (mode === "exit-immediately") process.exit(5);

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    handle(req);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(req) {
  if (mode === "never-ready") return;
  if (req.op === "hello") {
    send({ v: 1, kind: "response", id: req.id, ok: true, result: { ready: mode !== "refuse-hello", model: null } });
    if (mode === "stdout-noise") setTimeout(() => process.stdout.write("DEBUG: this is not protocol\n"), 50);
    if (mode === "wrong-id") setTimeout(() => send({ v: 1, kind: "response", id: "never-sent", ok: true, result: {} }), 50);
    if (mode === "forged-event") setTimeout(() => send({ v: 1, kind: "event", event: "task.finished", requestId: "x", taskId: "t-forged", seq: 1, data: { outcome: "completed" } }), 50);
    return;
  }
  if (mode === "mute-after-hello") return;
  if (req.op === "submit") {
    send({ v: 1, kind: "response", id: req.id, ok: true, result: { accepted: true, taskId: req.params.taskId } });
    if (mode === "bad-outcome") {
      setTimeout(() => send({ v: 1, kind: "event", event: "task.finished", requestId: req.id, taskId: req.params.taskId, seq: 1, data: { outcome: "definitely-succeeded", response: "All done!" } }), 20);
    }
    return;
  }
  send({ v: 1, kind: "response", id: req.id, ok: true, result: { ready: true, model: null } });
}
setInterval(() => {}, 1 << 30);
