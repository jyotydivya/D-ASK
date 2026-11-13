// ─────────────────────────────────────────────────────────────────────────────
// Dynamic plugins (agent side). The DAEMON is the authority: it validates a plugin folder, shows the user an approval
// card (id, version, tools, "compute only"), and records the approved SHA-256 of every file in its approved list
// (src/DAsk.Daemon/Automation/Plugins/PluginService.cs). This host only READS that list.
//
// Per task, sync() registers the tools of approved plugins as `plugin_<id>.<tool>` and removes revoked ones.
// Per call, the plugin's files are read, checked against the approved hashes, written to a fresh sealed folder, and run
// there in a separate `node --permission` process that may read only that folder and the runner: no file writes, no
// other files, no child processes, workers, addons or eval; the preload closes every network entry point; a minimal
// environment (no tokens), a 96 MB heap, and a timeout. Plugin output cannot be independently verified: it is labelled
// as such and a plugin task is at most "unverified" (plugin tools declare no facets).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonSchema, ToolRequestCheck, ToolSpec } from "../types";
import type { ToolRegistry } from "../toolRegistry";

export interface ApprovedPlugin {
  id: string; version: string; files: Record<string, string>; approvedUtc?: string;
  /** The permissions the user has granted, one by one. Absent (an older record) means only "compute". */
  granted?: string[];
  /** Approved but switched off: not offered, not run. */
  disabled?: boolean;
}
/** The permissions a plugin may declare. "compute" is granted by installing; the others need their own approval (daemon PluginService.GrantAsync). */
export type PluginPermission = "compute" | "files.read" | "memory.read";
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = ["compute", "files.read", "memory.read"];
/**
 * What the host can do FOR a plugin, only when the plugin's request is permitted. Each function does its own policy (file roots, secret
 * names, user-sourced memories only) so a granted permission is still bounded. Provided by stdioHost; absent in tests that do not need it.
 */
export interface PluginCapabilities {
  readFile?(requested: string, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  searchMemory?(query: string): Promise<string[]>;
}
export interface PluginToolManifest { name: string; description: string; inputSchema: JsonSchema; keywords?: string[]; timeoutMs?: number }
export interface PluginManifest { id: string; name: string; version: string; description?: string; entry: string; permissions: string[]; tools: PluginToolManifest[] }

export const PLUGIN_ID = /^[a-z][a-z0-9_]{1,30}$/;
export const PLUGIN_TOOL = /^[a-z][a-z0-9_]{1,30}$/;
const ALLOWED_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const MAX_TIMEOUT_MS = 10_000;

export interface PluginManagerOptions {
  /** Where plugin folders live (the daemon validates the same folder). */
  pluginsDir: string;
  /** The daemon's approved list (read-only here). */
  approvedPath: string;
  /** Folder holding sandboxRunner.cjs and sandboxPreload.cjs. */
  runtimeDir: string;
  nodePath?: string;
  log?: (line: string) => void;
  /** Host-mediated capabilities (files.read, memory.read). Without one, the matching request is refused as "not available". */
  capabilities?: PluginCapabilities;
  /** Append-only JSONL audit of every capability decision (default: next to the approved list). */
  auditPath?: string;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Strict manifest check (the daemon applies the same rules before approval). Returns an error or null. */
export function validateManifest(m: any): string | null {
  if (!m || typeof m !== "object") return "manifest must be an object";
  if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) return "id must be 2-31 lowercase letters, digits or _";
  if (typeof m.name !== "string" || m.name.length < 1 || m.name.length > 60) return "name is 1-60 characters";
  if (typeof m.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version)) return "version is MAJOR.MINOR.PATCH";
  if (typeof m.entry !== "string" || !/^[\w-]{1,60}\.(c?js)$/.test(m.entry)) return "entry is one .js/.cjs file in the plugin folder";
  if (!Array.isArray(m.permissions) || m.permissions.some((p: unknown) => typeof p !== "string" || !ALLOWED_PERMISSIONS.has(p))) return `permissions are chosen from: ${PLUGIN_PERMISSIONS.join(", ")}`;
  if (new Set(m.permissions).size !== m.permissions.length || !m.permissions.includes("compute")) return "permissions must include \"compute\" and list each permission once";
  if (!Array.isArray(m.tools) || m.tools.length < 1 || m.tools.length > 10) return "1 to 10 tools";
  for (const t of m.tools) {
    if (typeof t?.name !== "string" || !PLUGIN_TOOL.test(t.name)) return "tool names are 2-31 lowercase letters, digits or _";
    if (typeof t.description !== "string" || t.description.length < 5 || t.description.length > 300) return "tool descriptions are 5-300 characters";
    const s = t.inputSchema;
    if (!s || s.type !== "object" || typeof s.properties !== "object") return "each tool's inputSchema is an object schema";
    for (const p of Object.values<any>(s.properties)) if (!p || !["string", "number", "integer", "boolean"].includes(p.type)) return "input properties are strings, numbers or booleans";
    if (t.timeoutMs !== undefined && !(Number.isInteger(t.timeoutMs) && t.timeoutMs > 0 && t.timeoutMs <= MAX_TIMEOUT_MS)) return `timeoutMs is at most ${MAX_TIMEOUT_MS}`;
    if (t.keywords !== undefined && (!Array.isArray(t.keywords) || t.keywords.length > 12 || t.keywords.some((k: unknown) => typeof k !== "string" || !/^[\p{L}\p{N} -]{2,30}$/u.test(k)))) return "keywords are up to 12 short words";
  }
  return null;
}

export class PluginManager {
  private registered = new Set<string>();
  constructor(private readonly opts: PluginManagerOptions) {}

  approved(): ApprovedPlugin[] {
    try {
      const list = JSON.parse(readFileSync(this.opts.approvedPath, "utf8"));
      return Array.isArray(list) ? list.filter((p) => p && PLUGIN_ID.test(p.id) && p.files && typeof p.files === "object") : [];
    } catch { return []; }
  }

  /** Reads and verifies every approved file. Null (and nothing runs) if anything is missing, extra or different. */
  async verifiedFiles(p: ApprovedPlugin): Promise<Map<string, Buffer> | null> {
    const dir = path.join(this.opts.pluginsDir, p.id);
    let names: string[];
    try { names = (await fs.readdir(dir, { withFileTypes: true })).map((d) => (d.isFile() ? d.name : "\0dir")); } catch { return null; }
    const wanted = Object.keys(p.files).sort();
    if (names.includes("\0dir") || names.sort().join("\n") !== wanted.join("\n")) return null;
    const out = new Map<string, Buffer>();
    for (const rel of wanted) {
      if (!/^[\w.-]{1,80}$/.test(rel)) return null;
      const st = await fs.lstat(path.join(dir, rel)).catch(() => null);
      if (!st || !st.isFile()) return null;
      const b = await fs.readFile(path.join(dir, rel));
      if (sha256(b) !== p.files[rel]) return null;
      out.set(rel, b);
    }
    return out;
  }

  /** Registers the tools of approved, intact plugins and removes the others. Called before every task. */
  async sync(registry: ToolRegistry): Promise<{ registered: string[]; skipped: string[] }> {
    const want = new Map<string, ToolSpec<any, any>>();
    const skipped: string[] = [];
    for (const p of this.approved()) {
      if (p.disabled) { skipped.push(`${p.id}: disabled by the user`); continue; }
      const files = await this.verifiedFiles(p);
      if (!files) { skipped.push(`${p.id}: files missing or changed since approval`); continue; }
      let m: PluginManifest;
      try { m = JSON.parse(files.get("plugin.json")?.toString("utf8") ?? "null"); } catch { skipped.push(`${p.id}: unreadable manifest`); continue; }
      const err = validateManifest(m);
      if (err || m.id !== p.id || m.version !== p.version || !files.has(m.entry)) { skipped.push(`${p.id}: ${err ?? "manifest does not match the approval"}`); continue; }
      for (const t of m.tools) want.set(`plugin_${m.id}.${t.name}`, this.toolSpec(p, m, t));
    }
    for (const name of [...this.registered]) if (!want.has(name)) { registry.unregister(name); this.registered.delete(name); }
    for (const [name, spec] of want) {
      if (this.registered.has(name)) { registry.unregister(name); this.registered.delete(name); }
      if (registry.has(name)) { skipped.push(`${name}: name already used`); continue; }
      registry.register(spec); this.registered.add(name);
    }
    if (skipped.length) this.opts.log?.(`plugins skipped: ${skipped.join("; ")}`);
    return { registered: [...this.registered], skipped };
  }

  private toolSpec(p: ApprovedPlugin, m: PluginManifest, t: PluginToolManifest): ToolSpec<Record<string, unknown>, any> {
    const keywords = (t.keywords ?? []).map((k) => k.toLowerCase());
    const check: ToolRequestCheck<Record<string, unknown>, any> = {
      // A plugin is only OFFERED when the request uses one of its keywords; it never declares facets, so a task using it is at
      // most "unverified" (its output cannot be checked independently).
      relevant: (o) => keywords.some((k) => o.toLowerCase().includes(k)),
      // A request that uses the plugin's own keyword ("word count") is for that plugin: only it is offered. Found in the
      // real-HUD feature run (2026-11-10): offered alongside the built-ins, the local model chose math.evaluate.
      claims: (o) => keywords.some((k) => o.toLowerCase().includes(k)),
      facets: () => [],
      ground: () => ({ status: "ungrounded", reason: "plugin output cannot be independently verified" }),
      satisfies: () => false,
    };
    return {
      name: `plugin_${m.id}.${t.name}`,
      description: `[plugin ${m.name} ${m.version}] ${t.description}`,
      inputSchema: t.inputSchema as any,
      permissions: ["compute"],
      risk: "low",
      requiresApproval: false,
      timeoutMs: Math.min(t.timeoutMs ?? 5_000, MAX_TIMEOUT_MS) + 2_000,
      execute: async (input, ctx) => {
        const r = await this.invoke(p, m, t, input, ctx.signal);
        if (!r.ok) return { ok: false, error: `Plugin ${m.id}: ${r.error}`, evidence: "" };
        return { ok: true, output: r.output, evidence: `[plugin ${m.id} ${m.version}, output not independently verified] ${r.text}` };
      },
      requestCheck: check,
    };
  }

  /** Appends one decision to the audit log (JSON lines; never file contents, memory text or secrets). */
  audit(entry: Record<string, unknown>): void {
    try {
      const file = this.opts.auditPath ?? path.join(path.dirname(this.opts.approvedPath), "plugins-audit.jsonl");
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
    } catch { /* the audit must never break a task; the caller also logs the decision */ }
  }

  /**
   * Decides ONE capability request from a running plugin. The grant is read from the daemon's approved list at THIS moment (so a revocation
   * takes effect on the very next request), the permission must also be declared in the plugin's manifest, and the capability itself is
   * bounded by the host's own policy. Returns the reply line for the sandbox.
   */
  private async serveCapability(p: ApprovedPlugin, m: PluginManifest, t: PluginToolManifest, msg: any, signal: AbortSignal): Promise<Record<string, unknown>> {
    const id = msg?.id;
    const cap = String(msg?.cap);
    const deny = (code: string, text: string, detail: string) => {
      this.opts.log?.(`plugin ${m.id}.${t.name}: ${cap} denied (${detail})`);
      this.audit({ plugin: m.id, tool: t.name, permission: cap, decision: "denied", detail });
      return { id, ok: false, code, error: text };
    };
    if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(cap) || cap === "compute") return deny("ERR_PLUGIN_UNKNOWN_CAPABILITY", `The request ${cap} is not something a plugin can ask for.`, "unknown capability");
    const now = this.approved().find((x) => x.id === p.id);
    if (!now || now.disabled) return deny("ERR_PLUGIN_DISABLED", `The plugin ${m.id} is no longer installed or has been disabled.`, now ? "disabled" : "removed");
    const granted = now.granted ?? ["compute"];
    if (!m.permissions.includes(cap)) return deny("ERR_PLUGIN_PERMISSION_DENIED", `The plugin ${m.id} did not declare the ${cap} permission, so it cannot use it.`, "not declared in the manifest");
    if (!granted.includes(cap))
      return deny("ERR_PLUGIN_PERMISSION_DENIED", `The plugin ${m.id} does not have the ${cap} permission. You can allow it by saying: Grant the plugin ${m.id} the ${cap} permission.`, "not granted");
    try {
      if (cap === "files.read") {
        const requested = String(msg?.args?.path ?? "");
        if (!this.opts.capabilities?.readFile) return deny("ERR_PLUGIN_UNAVAILABLE", "Reading files is not available in this configuration.", "no provider");
        const r = await this.opts.capabilities.readFile(requested, signal);
        if (!r.ok) return deny("ERR_PLUGIN_FILE_REFUSED", `D-ASK did not read that file: ${r.reason}`, `file refused: ${r.reason}`);
        this.audit({ plugin: m.id, tool: t.name, permission: cap, decision: "allowed", detail: `read ${requested.slice(0, 200)} (${r.text.length} chars)` });
        return { id, ok: true, value: r.text };
      }
      // memory.read
      const query = String(msg?.args?.query ?? "").slice(0, 200);
      if (!this.opts.capabilities?.searchMemory) return deny("ERR_PLUGIN_UNAVAILABLE", "Local memory is not available in this configuration.", "no provider");
      const hits = await this.opts.capabilities.searchMemory(query);
      this.audit({ plugin: m.id, tool: t.name, permission: cap, decision: "allowed", detail: `memory search (${query.length} chars) -> ${hits.length} note(s)` });
      return { id, ok: true, value: hits };
    } catch (e) {
      return deny("ERR_PLUGIN_CAPABILITY_FAILED", `The request could not be completed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), "provider error");
    }
  }

  /** One sandboxed call. Public for tests. */
  async invoke(p: ApprovedPlugin, m: PluginManifest, t: PluginToolManifest, input: unknown, signal: AbortSignal): Promise<{ ok: true; output: unknown; text: string } | { ok: false; error: string }> {
    const files = await this.verifiedFiles(p);
    if (!files) return { ok: false, error: "its files are missing or changed since you approved it; it was not run" };
    const sealed = await fs.mkdtemp(path.join(os.tmpdir(), `dask-plugin-${m.id}-`));
    try {
      for (const [rel, b] of files) await fs.writeFile(path.join(sealed, rel), b);
      const runner = path.join(this.opts.runtimeDir, "sandboxRunner.cjs");
      const preload = path.join(this.opts.runtimeDir, "sandboxPreload.cjs");
      const args = ["--permission", `--allow-fs-read=${sealed}`, `--allow-fs-read=${runner}`, `--allow-fs-read=${preload}`,
        "--disallow-code-generation-from-strings", "--max-old-space-size=96", "--require", preload, runner];
      const env = { SystemRoot: process.env.SystemRoot ?? "", NODE_OPTIONS: "" } as unknown as NodeJS.ProcessEnv;   // no tokens, no paths, no proxy settings
      const child = spawn(this.opts.nodePath ?? process.execPath, args, { cwd: sealed, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const timeout = Math.min(t.timeoutMs ?? 5_000, MAX_TIMEOUT_MS);
      let errOut = "";
      let finalLine: string | null = null;
      let buffered = "";
      let total = 0;
      const answer = (obj: unknown) => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n"); };
      // One line per message. A line with "cap" is a REQUEST the host decides on; the first other line is the plugin's final result.
      const onLine = (line: string) => {
        if (!line.trim() || finalLine !== null) return;
        let msg: any;
        try { msg = JSON.parse(line); } catch { finalLine = line; return; }
        if (msg && typeof msg.cap === "string") { void this.serveCapability(p, m, t, msg, signal).then(answer); return; }
        finalLine = line;
      };
      child.stdout.setEncoding("utf8").on("data", (c: string) => {
        total += c.length; if (total > 400_000) { child.kill(); return; }
        buffered += c;
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) { const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1); onLine(line); }
      });
      child.stderr.setEncoding("utf8").on("data", (c) => { errOut = (errOut + c).slice(-2000); });
      const done = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
      const timer = setTimeout(() => child.kill(), timeout);
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdin.on("error", () => {});   // the plugin may exit while the host is still answering
      child.stdin.write(JSON.stringify({ entry: path.join(sealed, m.entry), tool: t.name, input }) + "\n");
      const code = await done;
      clearTimeout(timer); signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return { ok: false, error: "cancelled" };
      if (finalLine === null && buffered.trim()) onLine(buffered);
      const line = finalLine as string | null;
      if (!line) return { ok: false, error: code === null ? `stopped after ${timeout} ms` : `ended without a result (exit ${code})${errOut ? `: ${errOut.split("\n")[0]}` : ""}` };
      let r: any;
      try { r = JSON.parse(line); } catch { return { ok: false, error: "returned something that is not a result" }; }
      return r.ok === true ? { ok: true, output: r.output, text: String(r.text ?? "") } : { ok: false, error: String(r.error ?? "failed") };
    } finally {
      await fs.rm(sealed, { recursive: true, force: true }).catch(() => {});
    }
  }
}
