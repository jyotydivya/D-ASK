/**
 * Phase 4B-1R.7 — scenario runner (invoked by api-auth.test.ts in a subprocess).
 * Runs the real route handlers under one credential scenario and prints raw
 * results as a single "RESULT:" JSON line. Assertions live in the parent test.
 *
 * Usage: npx tsx tests/security/api-auth.scenario.ts <configured|unconfigured|short|equal|rotation>
 */
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface Row {
  endpoint: string;
  variant: string;
  status: number;
  contentType: string | null;
  acao: string | null;
  bodyUsed: boolean | null;
  leaked: boolean;
}

const scenario = process.argv[2] ?? "configured";
const taskToken = process.env.DASK_API_TASK_TOKEN ?? "";
const approveToken = process.env.DASK_API_APPROVE_TOKEN ?? "";
const ORIGIN = "http://localhost:3000";

function mkReq(method: string, path: string, opts: {
  token?: string; host?: string; origin?: string; body?: BodyInit; query?: string;
}): NextRequest {
  const headers: Record<string, string> = { host: opts.host ?? "localhost:3000" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.origin) headers["origin"] = opts.origin;
  if (typeof opts.body === "string") headers["content-type"] = "text/plain";
  return new NextRequest(`${ORIGIN}${path}${opts.query ?? ""}`, {
    method, headers, body: opts.body,
  });
}

async function main() {
  const { taskService } = await import("../../services/taskService");
  const tasksRoute = await import("../../app/api/tasks/route");
  const taskIdRoute = await import("../../app/api/tasks/[id]/route");
  const approveRoute = await import("../../app/api/tasks/[id]/approve/route");
  const eventsRoute = await import("../../app/api/tasks/[id]/events/route");
  const devicesRoute = await import("../../app/api/devices/route");
  const assistantRoute = await import("../../app/api/assistant/route");
  const sttRoute = await import("../../app/api/stt/route");

  const rows: Row[] = [];
  const secrets = [taskToken, approveToken].filter((s) => s.length > 0);

  async function call(endpoint: string, variant: string, handler: Handler, req: NextRequest, id = "nope") {
    const res = await handler(req, { params: Promise.resolve({ id }) });
    const text = res.body && res.headers.get("content-type")?.includes("text/event-stream")
      ? "" : await res.clone().text();
    rows.push({
      endpoint, variant,
      status: res.status,
      contentType: res.headers.get("content-type"),
      acao: res.headers.get("access-control-allow-origin"),
      bodyUsed: req.body === null ? null : req.bodyUsed,
      leaked: secrets.some((s) => text.includes(s)),
    });
    return res;
  }

  const wrongTokenFor = (scope: "task" | "approve") => (scope === "task" ? approveToken : taskToken);
  const validTokenFor = (scope: "task" | "approve") => (scope === "task" ? taskToken : approveToken);
  const bad = randomBytes(32).toString("base64url");

  // endpoint, handler, method, path, scope, body factory, valid-credential body
  const cases: {
    name: string; handler: Handler; method: string; path: string; scope: "task" | "approve";
    body?: () => BodyInit; validCheck: boolean;
  }[] = [
    { name: "POST /api/tasks", handler: tasksRoute.POST as Handler, method: "POST", path: "/api/tasks", scope: "task",
      body: () => JSON.stringify({ objective: "" }), validCheck: true },
    { name: "GET /api/tasks", handler: tasksRoute.GET as Handler, method: "GET", path: "/api/tasks", scope: "task", validCheck: true },
    { name: "GET /api/tasks/:id", handler: taskIdRoute.GET as Handler, method: "GET", path: "/api/tasks/nope", scope: "task", validCheck: true },
    { name: "DELETE /api/tasks/:id", handler: taskIdRoute.DELETE as Handler, method: "DELETE", path: "/api/tasks/nope", scope: "task", validCheck: true },
    { name: "POST /api/tasks/:id/approve", handler: approveRoute.POST as Handler, method: "POST", path: "/api/tasks/nope/approve", scope: "approve",
      body: () => JSON.stringify({ approvalId: "nope", decision: "approved" }), validCheck: true },
    { name: "GET /api/tasks/:id/events", handler: eventsRoute.GET as Handler, method: "GET", path: "/api/tasks/nope/events", scope: "task", validCheck: true },
    { name: "GET /api/devices", handler: devicesRoute.GET as Handler, method: "GET", path: "/api/devices", scope: "task", validCheck: false },
    { name: "POST /api/devices", handler: devicesRoute.POST as Handler, method: "POST", path: "/api/devices", scope: "task",
      body: () => JSON.stringify({}), validCheck: true },
    { name: "POST /api/assistant", handler: assistantRoute.POST as unknown as Handler, method: "POST", path: "/api/assistant", scope: "task",
      body: () => JSON.stringify({}), validCheck: true },
    { name: "POST /api/stt", handler: sttRoute.POST as unknown as Handler, method: "POST", path: "/api/stt", scope: "task",
      body: () => new FormData(), validCheck: true },
  ];

  const before = taskService.listTasks().length;

  if (scenario === "rotation") {
    // Credentials are read once per process; changing env afterwards must not rotate them.
    const original = taskToken;
    const rotated = randomBytes(32).toString("base64url");
    await call("rotation", "original-before", tasksRoute.GET as Handler, mkReq("GET", "/api/tasks", { token: original }));
    process.env.DASK_API_TASK_TOKEN = rotated;
    await call("rotation", "original-after-env-change", tasksRoute.GET as Handler, mkReq("GET", "/api/tasks", { token: original }));
    await call("rotation", "rotated-after-env-change", tasksRoute.GET as Handler, mkReq("GET", "/api/tasks", { token: rotated }));
  } else {
    for (const c of cases) {
      const mk = (o: Parameters<typeof mkReq>[2]) =>
        mkReq(c.method, c.path, { ...o, body: c.body ? c.body() : undefined });
      await call(c.name, "no-credential", c.handler, mk({}));
      await call(c.name, "invalid-token", c.handler, mk({ token: bad }));
      await call(c.name, "wrong-scope", c.handler, mk({ token: wrongTokenFor(c.scope) }));
      await call(c.name, "token-in-query-only", c.handler, mk({ query: `?token=${validTokenFor(c.scope)}&access_token=${validTokenFor(c.scope)}` }));
      await call(c.name, "trusted-origin-no-token", c.handler, mk({ origin: ORIGIN }));
      await call(c.name, "valid-token-foreign-host", c.handler, mk({ token: validTokenFor(c.scope), host: "evil.example" }));
      await call(c.name, "valid-token-lan-host", c.handler, mk({ token: validTokenFor(c.scope), host: "192.168.1.20:3000" }));
      if (c.validCheck) await call(c.name, "valid", c.handler, mk({ token: validTokenFor(c.scope) }));
    }
  }

  const afterDenied = taskService.listTasks().length;

  // Approval flow: scopes are strictly separate, and denied calls change nothing.
  let approval: Record<string, unknown> = {};
  if (scenario === "configured") {
    const task = taskService.createTask("scenario", "s1");
    const appr = taskService.createApproval(task.id, "n1", "pc.mouse_move", {}, "d", "low");
    const body = () => JSON.stringify({ approvalId: appr.id, decision: "approved" });
    const post = approveRoute.POST as Handler;
    await call("approve-flow", "task-token", post, mkReq("POST", `/api/tasks/${task.id}/approve`, { token: taskToken, body: body() }), task.id);
    const stillPending = taskService.getApproval(appr.id)?.status === "pending";
    await call("approve-flow", "no-token", post, mkReq("POST", `/api/tasks/${task.id}/approve`, { body: body() }), task.id);
    const stillPending2 = taskService.getApproval(appr.id)?.status === "pending";
    await call("approve-flow", "approve-token", post, mkReq("POST", `/api/tasks/${task.id}/approve`, { token: approveToken, body: body() }), task.id);
    const resolved = taskService.getApproval(appr.id)?.status === "approved";

    // Approve-scope token must not reach task endpoints (covered in matrix); and
    // event stream: authenticated request returns SSE without wildcard CORS.
    const ev = await (eventsRoute.GET as Handler)(
      mkReq("GET", `/api/tasks/${task.id}/events`, { token: taskToken }), { params: Promise.resolve({ id: task.id }) });
    approval = {
      stillPendingAfterTaskToken: stillPending,
      stillPendingAfterNoToken: stillPending2,
      resolvedWithApproveToken: resolved,
      sseStatus: ev.status,
      sseContentType: ev.headers.get("content-type"),
      sseAcao: ev.headers.get("access-control-allow-origin"),
    };
    await ev.body?.cancel();
  }

  console.log("RESULT:" + JSON.stringify({ scenario, rows, before, afterDenied, approval }));
  process.exit(0);
}

main().catch((e) => {
  console.error("SCENARIO ERROR", e);
  process.exit(2);
});
