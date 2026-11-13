// ─────────────────────────────────────────────────────────────────────────────
// Built-in safe tools for the agent runtime (vertical slice).
//
// All are read-only or pure computation: no shell, no network, no desktop
// actuation, no file writes. Each returns structured output plus a short
// evidence string describing what was actually observed.
// ─────────────────────────────────────────────────────────────────────────────

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { ToolSpec } from "../types";
import { createMathRequestCheck, infoRequestCheck, listDirRequestCheck, timeRequestCheck } from "./requestChecks";

// ── system.time ──────────────────────────────────────────────────────────────

export interface TimeOutput { iso: string; local: string; timeZone: string; epochMs: number }

export const systemTimeTool: ToolSpec<{ timeZone?: string }, TimeOutput> = {
  name: "system.time",
  description: "Get the current date and time of this computer, optionally rendered in an IANA time zone (e.g. \"Asia/Kolkata\").",
  inputSchema: {
    type: "object",
    properties: { timeZone: { type: "string", maxLength: 64, pattern: "^[A-Za-z_]+(/[A-Za-z_+-]+){0,2}$|^UTC$" } },
  },
  permissions: ["read:clock"],
  risk: "low",
  requiresApproval: false,
  timeoutMs: 2_000,
  async execute(input) {
    const now = new Date();
    const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let local: string;
    try {
      local = now.toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" });
    } catch {
      return { ok: false, error: `Unknown time zone "${timeZone}"`, evidence: "" };
    }
    const output = { iso: now.toISOString(), local, timeZone, epochMs: now.getTime() };
    return { ok: true, output, evidence: `Current time in ${timeZone}: ${local}` };
  },
  check(_input, outcome) {
    const ok = !!outcome.output && !Number.isNaN(Date.parse(outcome.output.iso));
    return ok ? { ok } : { ok, reason: "no valid timestamp in output" };
  },
  requestCheck: timeRequestCheck,
};

// ── system.info ──────────────────────────────────────────────────────────────

export interface SystemInfoOutput {
  platform: string; release: string; arch: string;
  cpuCount: number; cpuModel: string;
  totalMemBytes: number; freeMemBytes: number; uptimeSeconds: number;
}

export const systemInfoTool: ToolSpec<Record<string, never>, SystemInfoOutput> = {
  name: "system.info",
  description: "Read basic hardware and OS facts of this computer: OS, CPU count/model, total and free memory, uptime. No user or network identifiers.",
  inputSchema: { type: "object", properties: {} },
  permissions: ["read:system"],
  risk: "low",
  requiresApproval: false,
  timeoutMs: 2_000,
  async execute() {
    const cpus = os.cpus();
    const output: SystemInfoOutput = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model?.trim() ?? "unknown",
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
    };
    const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
    return {
      ok: true,
      output,
      evidence: `${output.platform} ${output.release} (${output.arch}); ${output.cpuCount} logical CPUs (${output.cpuModel}); ` +
        `memory ${gb(output.freeMemBytes)} GB free of ${gb(output.totalMemBytes)} GB; up ${(output.uptimeSeconds / 3600).toFixed(1)} h`,
    };
  },
  check(_input, outcome) {
    const o = outcome.output;
    const ok = !!o && o.totalMemBytes > 0 && o.cpuCount > 0;
    return ok ? { ok } : { ok, reason: "implausible system figures" };
  },
  requestCheck: infoRequestCheck,
};

// ── math.evaluate ────────────────────────────────────────────────────────────

export const mathEvaluateTool: ToolSpec<{ expression: string }, { expression: string; value: number }> = {
  name: "math.evaluate",
  description: "Evaluate an arithmetic expression exactly as written: numbers, + - * / % ^, parentheses. No variables or functions.",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["expression"],
  },
  permissions: ["compute"],
  risk: "low",
  requiresApproval: false,
  timeoutMs: 1_000,
  async execute(input) {
    let value: number;
    try {
      value = evaluateArithmetic(input.expression);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), evidence: "" };
    }
    if (!Number.isFinite(value)) return { ok: false, error: "Result is not a finite number", evidence: "" };
    return { ok: true, output: { expression: input.expression, value }, evidence: `${input.expression} = ${value}` };
  },
  check(_input, outcome) {
    const ok = typeof outcome.output?.value === "number" && Number.isFinite(outcome.output.value);
    return ok ? { ok } : { ok, reason: "no finite numeric result" };
  },
  // Lazy wrapper: evaluateArithmetic is defined below in this module.
  requestCheck: createMathRequestCheck((s) => evaluateArithmetic(s)),
};

/** Recursive-descent evaluator. Grammar: expr := term (('+'|'-') term)*; term := unary (('*'|'/'|'%') unary)*;
 *  unary := '-' unary | '+' unary | power; power := primary ('^' unary)?; primary := number | '(' expr ')'.
 *  So -2^2 = -(2^2) = -4, 2^-1 = 0.5 and 2^3^2 = 2^(3^2) = 512. */
export function evaluateArithmetic(src: string): number {
  if (src.length > 200) throw new Error("Expression too long");
  let i = 0;
  let depth = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const peek = () => { ws(); return src[i]; };
  const fail = (msg: string): never => { throw new Error(`${msg} at position ${i}`); };

  const primary = (): number => {
    const c = peek();
    if (c === "(") {
      if (++depth > 32) fail("Nesting too deep");
      i++;
      const v = expr();
      if (peek() !== ")") fail("Expected ')'");
      i++; depth--;
      return v;
    }
    const m = /^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) fail("Expected a number");
    i += m![0].length;
    return Number(m![0]);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") { i++; return Math.pow(base, unary()); }
    return base;
  };
  const unary = (): number => {
    const c = peek();
    if (c === "-" || c === "+") {
      if (++depth > 32) fail("Nesting too deep");
      i++;
      const v = unary();
      depth--;
      return c === "-" ? -v : v;
    }
    return power();
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= unary(); }
      else if (c === "/") { i++; const d = unary(); if (d === 0) fail("Division by zero"); v /= d; }
      else if (c === "%") { i++; const d = unary(); if (d === 0) fail("Modulo by zero"); v %= d; }
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  };

  const value = expr();
  ws();
  if (i !== src.length) fail("Unexpected character");
  return value;
}

// ── workspace.list_dir ───────────────────────────────────────────────────────

const HIDDEN_SEGMENTS = new Set([".git", "node_modules", ".next", ".venv", ".nuget", ".xwin-sdk", ".xwin-cache", ".dotnet_home"]);
const isSecretName = (name: string) => /^\.env/i.test(name) || /\.(pem|key|pfx|p12)$/i.test(name);
const MAX_ENTRIES = 200;

export interface ListDirOutput { path: string; entries: { name: string; type: "dir" | "file" | "other" }[]; truncated: boolean; hidden: number }

/**
 * Lists names (never contents) inside a fixed root. Paths are confined to the
 * root after resolving symlinks; VCS/dependency folders and secret-looking
 * files are not listed or entered.
 */
export function createWorkspaceListDirTool(rootDir: string): ToolSpec<{ path?: string }, ListDirOutput> {
  const root = path.resolve(rootDir);
  return {
    name: "workspace.list_dir",
    description: "List the names of files and folders inside the D-ASK workspace. `path` is relative to the workspace root (default \".\"). Contents are never read.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", maxLength: 260 } },
    },
    permissions: ["read:workspace"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 3_000,
    async execute(input, ctx) {
      const rel = (input.path ?? ".").replace(/\\/g, "/");
      if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { ok: false, error: "Path must be relative to the workspace root", evidence: "" };
      const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
      if (segments.some((s) => s === ".." || HIDDEN_SEGMENTS.has(s.toLowerCase()) || isSecretName(s))) {
        return { ok: false, error: "Path is outside the workspace or not listable", evidence: "" };
      }
      const target = path.resolve(root, ...segments);
      let realRoot: string, realTarget: string;
      try {
        realRoot = await fs.realpath(root);
        realTarget = await fs.realpath(target);
      } catch {
        return { ok: false, error: `No such folder: ${rel}`, evidence: "" };
      }
      const within = path.relative(realRoot, realTarget);
      if (within.startsWith("..") || path.isAbsolute(within)) return { ok: false, error: "Path resolves outside the workspace", evidence: "" };
      if (ctx.signal.aborted) return { ok: false, error: "Cancelled", evidence: "" };

      let dirents;
      try {
        dirents = await fs.readdir(realTarget, { withFileTypes: true });
      } catch (err) {
        return { ok: false, error: `Cannot list ${rel}: ${(err as NodeJS.ErrnoException).code ?? "error"}`, evidence: "" };
      }
      const visible = dirents.filter((d) => !isSecretName(d.name) && !HIDDEN_SEGMENTS.has(d.name.toLowerCase()));
      const entries = visible
        .slice(0, MAX_ENTRIES)
        .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" as const : d.isFile() ? "file" as const : "other" as const }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      const shown = rel === "" ? "." : rel;
      const dirs = entries.filter((e) => e.type === "dir").length;
      return {
        ok: true,
        output: { path: shown, entries, truncated: visible.length > MAX_ENTRIES, hidden: dirents.length - visible.length },
        evidence: `"${shown}" contains ${entries.length} visible entries (${dirs} folders, ${entries.length - dirs} files)` +
          (entries.length ? `: ${entries.slice(0, 15).map((e) => e.name + (e.type === "dir" ? "/" : "")).join(", ")}${entries.length > 15 ? ", …" : ""}` : ""),
      };
    },
    check(_input, outcome) {
      const ok = Array.isArray(outcome.output?.entries);
      return ok ? { ok } : { ok, reason: "no directory listing in output" };
    },
    requestCheck: listDirRequestCheck,
  };
}
