/**
 * Phase 4B-1R.7 — API authentication tests (C3).
 * Run with: npx tsx tests/security/api-auth.test.ts
 *
 * Parts:
 *   A. createAuthenticator unit tests (pure, in-process)
 *   B. Real route handlers under 5 credential scenarios (subprocesses)
 *   C. Static route-coverage guard (every exported handler authenticates first)
 *   D. Secret hygiene
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAuthenticator } from "../../lib/security/apiAuth";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label); }
}
const tok = () => randomBytes(32).toString("base64url");
const ROOT = path.resolve(__dirname, "..", "..");

function req(opts: { auth?: string; host?: string; origin?: string; url?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  if (opts.host !== undefined) headers["host"] = opts.host;
  if (opts.origin !== undefined) headers["origin"] = opts.origin;
  return new Request(opts.url ?? "http://localhost:3000/api/tasks", { headers });
}
const status = (d: ReturnType<ReturnType<typeof createAuthenticator>["authenticate"]>) => (d.ok ? 200 : d.status);

// ── A. createAuthenticator unit tests ───────────────────────────────────────
console.log("\n[A] createAuthenticator");
{
  const T = tok(), A = tok();
  const auth = createAuthenticator({ DASK_API_TASK_TOKEN: T, DASK_API_APPROVE_TOKEN: A });
  check(auth.configured, "configured with two valid distinct tokens");
  check(status(auth.authenticate(req({ host: "localhost:3000" }), "task")) === 401, "missing credential -> 401");
  check(status(auth.authenticate(req({ auth: "Basic abc", host: "localhost" }), "task")) === 401, "non-Bearer scheme -> 401");
  check(status(auth.authenticate(req({ auth: "Bearer", host: "localhost" }), "task")) === 401, "empty Bearer -> 401");
  check(status(auth.authenticate(req({ auth: "Bearer " + tok(), host: "localhost" }), "task")) === 401, "invalid token -> 401");
  check(status(auth.authenticate(req({ auth: "Bearer " + "a".repeat(5000), host: "localhost" }), "task")) === 401, "oversized token -> 401");
  check(status(auth.authenticate(req({ auth: `Bearer ${T} extra`, host: "localhost" }), "task")) === 401, "token with trailing junk -> 401");
  check(status(auth.authenticate(req({ auth: `Bearer ${T}`, host: "localhost:3000" }), "task")) === 200, "valid task token on task scope -> ok");
  check(status(auth.authenticate(req({ auth: `bearer ${T}`, host: "localhost:3000" }), "task")) === 200, "scheme is case-insensitive");
  check(status(auth.authenticate(req({ auth: `Bearer ${A}`, host: "localhost:3000" }), "approve")) === 200, "valid approve token on approve scope -> ok");
  check(status(auth.authenticate(req({ auth: `Bearer ${A}`, host: "localhost" }), "task")) === 403, "approve token on task scope -> 403");
  check(status(auth.authenticate(req({ auth: `Bearer ${T}`, host: "localhost" }), "approve")) === 403, "task token on approve scope -> 403");
  check(status(auth.authenticate(req({ url: `http://localhost:3000/api/tasks?token=${T}`, host: "localhost" }), "task")) === 401, "token in query string is ignored");
  check(status(auth.authenticate(req({ origin: "http://localhost:3000", host: "localhost:3000" }), "task")) === 401, "trusted-looking Origin grants nothing");
  for (const h of ["127.0.0.1:3000", "[::1]:3000", "LOCALHOST:8080", "localhost"]) {
    check(status(auth.authenticate(req({ auth: `Bearer ${T}`, host: h }), "task")) === 200, `loopback Host accepted: ${h}`);
  }
  for (const h of ["evil.example", "localhost.evil.example", "192.168.1.20:3000", "0.0.0.0:3000", "127.0.0.1.evil.example"]) {
    check(status(auth.authenticate(req({ auth: `Bearer ${T}`, host: h }), "task")) === 403, `non-loopback Host rejected even with valid token: ${h}`);
  }
  check(Object.isFrozen(auth), "authenticator object is frozen");

  // Rotation: env mutation after creation has no effect (restart required).
  const env: Record<string, string | undefined> = { DASK_API_TASK_TOKEN: T, DASK_API_APPROVE_TOKEN: A };
  const a2 = createAuthenticator(env);
  env.DASK_API_TASK_TOKEN = tok();
  check(status(a2.authenticate(req({ auth: `Bearer ${T}`, host: "localhost" }), "task")) === 200, "credentials are read once; later env changes do not rotate");
}
{
  const good = tok();
  const unconfigured: [string, Record<string, string | undefined>][] = [
    ["both unset", {}],
    ["approve unset", { DASK_API_TASK_TOKEN: good }],
    ["task unset", { DASK_API_APPROVE_TOKEN: good }],
    ["task too short", { DASK_API_TASK_TOKEN: "short", DASK_API_APPROVE_TOKEN: good }],
    ["tokens equal", { DASK_API_TASK_TOKEN: good, DASK_API_APPROVE_TOKEN: good }],
    ["bad charset", { DASK_API_TASK_TOKEN: good.slice(0, 42) + "!", DASK_API_APPROVE_TOKEN: tok() }],
    ["empty strings", { DASK_API_TASK_TOKEN: "", DASK_API_APPROVE_TOKEN: "" }],
  ];
  for (const [label, env] of unconfigured) {
    const a = createAuthenticator(env);
    const presented = env.DASK_API_TASK_TOKEN ?? good;
    check(!a.configured && status(a.authenticate(req({ auth: `Bearer ${presented}`, host: "localhost" }), "task")) === 503,
      `unconfigured (${label}) -> 503 for every credential`);
  }
}

// ── B. Real route handlers, one subprocess per credential scenario ──────────
type Row = { endpoint: string; variant: string; status: number; contentType: string | null; acao: string | null; bodyUsed: boolean | null; leaked: boolean };
type Result = { scenario: string; rows: Row[]; before: number; afterDenied: number; approval: Record<string, unknown> };

function runScenario(name: string, env: Record<string, string>): Result | null {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.DASK_API_TASK_TOKEN;
  delete clean.DASK_API_APPROVE_TOKEN;
  const r = spawnSync("npx tsx tests/security/api-auth.scenario.ts " + name, {
    cwd: ROOT, env: { ...clean, ...env }, shell: true, encoding: "utf8", timeout: 240_000,
  });
  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
  if (!line) {
    console.error(`  scenario ${name} produced no result (exit ${r.status})\n${r.stderr}\n${r.stdout}`);
    return null;
  }
  return JSON.parse(line.slice("RESULT:".length)) as Result;
}

const ENDPOINTS = [
  "POST /api/tasks", "GET /api/tasks", "GET /api/tasks/:id", "DELETE /api/tasks/:id",
  "POST /api/tasks/:id/approve", "GET /api/tasks/:id/events",
  "GET /api/devices", "POST /api/devices", "POST /api/assistant", "POST /api/stt",
];
const DENIED_VARIANTS: [string, number][] = [
  ["no-credential", 401], ["invalid-token", 401], ["wrong-scope", 403], ["token-in-query-only", 401],
  ["trusted-origin-no-token", 401], ["valid-token-foreign-host", 403], ["valid-token-lan-host", 403],
];

console.log("\n[B1] Route handlers — configured credentials");
{
  const res = runScenario("configured", { DASK_API_TASK_TOKEN: tok(), DASK_API_APPROVE_TOKEN: tok() });
  check(res !== null, "scenario ran");
  if (res) {
    const get = (e: string, v: string) => res.rows.find((r) => r.endpoint === e && r.variant === v);
    for (const e of ENDPOINTS) {
      for (const [v, want] of DENIED_VARIANTS) {
        const row = get(e, v);
        check(row?.status === want, `${e} [${v}] -> ${want} (got ${row?.status})`);
        if (row && row.bodyUsed !== null) check(row.bodyUsed === false, `${e} [${v}] request body not read before auth`);
      }
    }
    check(res.rows.every((r) => !r.leaked), "no response body contains a credential");
    check(res.rows.filter((r) => r.status === 401).every((r) => r.contentType?.includes("application/json")), "401 bodies are JSON");

    // Valid credentials pass auth and reach the handler (expected handler status, never 401/403/503).
    const validExpect: [string, number][] = [
      ["POST /api/tasks", 400], ["GET /api/tasks", 200], ["GET /api/tasks/:id", 404], ["DELETE /api/tasks/:id", 404],
      ["POST /api/tasks/:id/approve", 404], ["GET /api/tasks/:id/events", 404],
      ["POST /api/devices", 400], ["POST /api/assistant", 400], ["POST /api/stt", 400],
    ];
    for (const [e, want] of validExpect) {
      check(get(e, "valid")?.status === want, `${e} [valid] reaches handler -> ${want} (got ${get(e, "valid")?.status})`);
    }
    check(res.afterDenied === res.before, `no task created by any denied or empty-body call (${res.before} -> ${res.afterDenied})`);

    const ap = res.approval;
    check(ap.stillPendingAfterTaskToken === true, "task-scope token cannot resolve an approval");
    check(ap.stillPendingAfterNoToken === true, "unauthenticated request cannot resolve an approval");
    check(ap.resolvedWithApproveToken === true, "approve-scope token resolves the approval");
    check(ap.sseStatus === 200 && String(ap.sseContentType).includes("text/event-stream"), "authenticated event stream starts");
    check(ap.sseAcao === null, "event stream sends no Access-Control-Allow-Origin");
    const denyEvents = res.rows.filter((r) => r.endpoint === "GET /api/tasks/:id/events" && r.variant !== "valid");
    check(denyEvents.every((r) => !String(r.contentType).includes("text/event-stream")), "denied event-stream requests never start streaming");
  }
}

for (const [name, env, expect] of [
  ["unconfigured", {}, 503],
  ["short", { DASK_API_TASK_TOKEN: "tooshort", DASK_API_APPROVE_TOKEN: "alsoshort" }, 503],
  ["equal", (() => { const t = tok(); return { DASK_API_TASK_TOKEN: t, DASK_API_APPROVE_TOKEN: t }; })(), 503],
] as [string, Record<string, string>, number][]) {
  console.log(`\n[B2] Route handlers — ${name} credentials fail closed`);
  const res = runScenario(name, env);
  check(res !== null, "scenario ran");
  if (res) {
    const all = res.rows;
    check(all.every((r) => r.status === expect), `every route and credential variant -> ${expect} (${all.length} requests)`);
    check(res.afterDenied === res.before, "no task created");
  }
}

console.log("\n[B3] Route handlers — credentials read once per process (rotation requires restart)");
{
  const res = runScenario("rotation", { DASK_API_TASK_TOKEN: tok(), DASK_API_APPROVE_TOKEN: tok() });
  check(res !== null, "scenario ran");
  if (res) {
    const s = (v: string) => res.rows.find((r) => r.variant === v)?.status;
    check(s("original-before") === 200, "original token accepted");
    check(s("original-after-env-change") === 200, "original token still accepted after env change");
    check(s("rotated-after-env-change") === 401, "env-changed token not accepted until restart");
  }
}

// ── C. Static route-coverage guard ──────────────────────────────────────────
console.log("\n[C] Every exported handler on every API route authenticates first");
{
  const apiDir = path.join(ROOT, "app", "api");
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name === "route.ts") files.push(p);
    }
  })(apiDir);

  const expected: Record<string, string[]> = {
    "tasks/route.ts": ["GET", "POST"],
    "tasks/[id]/route.ts": ["DELETE", "GET"],
    "tasks/[id]/approve/route.ts": ["POST"],
    "tasks/[id]/events/route.ts": ["GET"],
    "devices/route.ts": ["GET", "POST"],
    "assistant/route.ts": ["POST"],
    "stt/route.ts": ["POST"],
  };
  const rel = (f: string) => path.relative(apiDir, f).split(path.sep).join("/");
  check(files.map(rel).sort().join(",") === Object.keys(expected).sort().join(","), "route file set matches the audited list (a new route must be added here and guarded)");

  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const name = rel(f);
    const handlers = [...src.matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
    check(handlers.map((m) => m[1]).sort().join(",") === (expected[name] ?? []).slice().sort().join(","), `${name}: exported handlers = ${(expected[name] ?? []).join("/")}`);
    for (let i = 0; i < handlers.length; i++) {
      const start = handlers[i]!.index!;
      const end = i + 1 < handlers.length ? handlers[i + 1]!.index! : src.length;
      const body = src.slice(start, end);
      const g = body.indexOf("requireAuth(");
      const prefix = g === -1 ? body : body.slice(0, g);
      const scope = name.endsWith("approve/route.ts") ? "approve" : "task";
      check(g !== -1 && new RegExp(`requireAuth\\(\\s*\\w+,\\s*['"]${scope}['"]\\s*\\)`).test(body.slice(g, g + 80)),
        `${name} ${handlers[i]![1]}: calls requireAuth(…, "${scope}")`);
      check(g !== -1 && !/\bawait\b|\.json\(|formData\(|\.text\(|searchParams|nextUrl|\bparams\b\s*;/.test(prefix.replace(/\{\s*params\s*\}\s*:\s*\{\s*params:[^}]*\}\s*\}?/, "")),
        `${name} ${handlers[i]![1]}: guard precedes any await / body / query / params access`);
    }
    check(!/Access-Control-Allow-Origin/i.test(src), `${name}: no CORS allow-origin header`);
  }
}

// ── D. Secret hygiene ───────────────────────────────────────────────────────
console.log("\n[D] Secret hygiene");
{
  const walkSrc = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git", ".venv", "target", "bin", "obj", "results", "scratch"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkSrc(p, out);
      else if (/\.(ts|tsx|js|mjs|json|rs|cs)$/.test(e.name) && !p.includes(path.join("tests", "security"))) out.push(p);
    }
    return out;
  };
  const srcFiles = ["app", "components", "hooks", "lib", "services", "agent", "tools"].flatMap((d) => walkSrc(path.join(ROOT, d)));
  srcFiles.push(path.join(ROOT, "main.js"));
  const offenders = srcFiles.filter((f) => /NEXT_PUBLIC_DASK|DASK_API_(TASK|APPROVE)_TOKEN/.test(fs.readFileSync(f, "utf8")));
  check(offenders.length === 1 && offenders[0]!.endsWith(path.join("lib", "security", "apiAuth.ts")),
    `token env names appear only in lib/security/apiAuth.ts (found: ${offenders.map((o) => path.relative(ROOT, o)).join(", ") || "none"})`);
  const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  check(/^DASK_API_TASK_TOKEN=\s*$/m.test(envExample) && /^DASK_API_APPROVE_TOKEN=\s*$/m.test(envExample), ".env.example token values are blank");
  const authSrc = fs.readFileSync(path.join(ROOT, "lib", "security", "apiAuth.ts"), "utf8");
  check(!/console\./.test(authSrc), "apiAuth.ts never logs");
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  check(/server\.listen\(port, '127\.0\.0\.1'/.test(mainJs), "main.js binds loopback only");
  check(!/token|authorization/i.test(mainJs), "main.js holds no authentication logic");
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  check(/"dev": "next dev -H 127\.0\.0\.1"/.test(pkg) && /"start": "next start -H 127\.0\.0\.1"/.test(pkg), "dev/start scripts bind loopback");
}

console.log("\n" + "-".repeat(60));
console.log(`Phase 4B-1R.7 API Auth Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("SOME TESTS FAILED"); process.exit(1); }
console.log("ALL TESTS PASSED");
