/**
 * Phase 7A: read-only filesystem tools — behaviour, security boundaries and verification.
 * Run with: npx tsx tests/agent-runtime/filesystem.test.ts
 *
 * Every fixture is synthetic and lives in a fresh temporary folder outside the repository. Nothing here reads
 * the user's own files. Tools are invoked through the real ToolRegistry (input validation, permissions,
 * timeouts), and the runtime parts use the real Planner, Verifier and AgentRuntime with a scripted model.
 */
import os from "node:os";
import path from "node:path";
import { promises as fs, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DENY_ALL_APPROVALS, ToolRegistry } from "../../agent/runtime/toolRegistry";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { checkArguments, argumentDomainsFor, clarificationFor, detectFacets } from "../../agent/runtime/grounding";
import { resolveRoots, checkPathText, redactSecrets, decodeText } from "../../agent/runtime/tools/fileAccess";
import { findSection } from "../../agent/runtime/tools/filesystem";
import { requestedExtensions, requestedFiles, textQuery, nameTerms, isFileSearch, isTextSearch, isReadRequest, isMetadataRequest, readClarification } from "../../agent/runtime/tools/filesystemChecks";
import type { LanguageModel, StructuredRequest } from "../../agent/runtime/types";

let passed = 0;
let failed = 0;
const notes: string[] = [];
function check(cond: unknown, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail).slice(0, 400)}` : "")); }
}

// ── Synthetic fixtures ──────────────────────────────────────────────────────

const TMP = mkdtempSync(path.join(os.tmpdir(), "dask-fs-test-"));
const PROJ = path.join(TMP, "proj");
const OUTSIDE = path.join(TMP, "outside");
const W = (rel: string, data: string | Buffer) => fs.mkdir(path.dirname(path.join(PROJ, rel)), { recursive: true }).then(() => fs.writeFile(path.join(PROJ, rel), data));
const SECRET_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);

async function buildFixtures(): Promise<void> {
  await fs.mkdir(OUTSIDE, { recursive: true });
  await fs.writeFile(path.join(OUTSIDE, "private-notes.md"), "# Outside\nThe architecture of something private.\n");
  await W("README.md", "# Demo project\nA synthetic project for D-ASK tests.\n");
  await W("docs/architecture.md", "# Architecture\n\nThe architecture has three layers.\nNothing else here.\nARCHITECTURE notes, upper case.\n");
  await W("docs/guide.md", "# Guide\nHow to use the demo.\n");
  await W("docs/reports/2026-q2-report.md", "# Q2 Report\n\n## 1. Introduction\nOlder report.\n\n## 2. Results\nNone.\n");
  await W("docs/reports/2026-q3-report.md", [
    "# Q3 Report", "", "## 1. Introduction", "This quarter the team rebuilt the architecture.", "It now runs fully offline.", "",
    "## 2. Results", "Latency fell by half.", "", "### 2.1 Details", "More numbers.", "", "## 3. Conclusion", "Ship it.", "",
  ].join("\n"));
  const old = new Date("2026-07-01T10:00:00Z");
  const newer = new Date("2026-10-01T10:00:00Z");
  await fs.utimes(path.join(PROJ, "docs/reports/2026-q2-report.md"), old, old);
  await fs.utimes(path.join(PROJ, "docs/reports/2026-q3-report.md"), newer, newer);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 255, 254, 0, 7]), Buffer.from("\n%%EOF\n")]);
  await W("docs/manual.pdf", pdf);
  await W("reports/annual-2025.pdf", pdf);
  await W("data/guide.md", "# Data guide\n");                                       // second guide.md: ambiguous bare name
  await W("data/notes-utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("UTF-16 notes about architecture\r\nline two\r\n", "utf16le")]));
  await W("data/legacy-1252.txt", Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x72, 0x63, 0x68, 0x69, 0x74, 0x65, 0x63, 0x74, 0x75, 0x72, 0x65, 0x0a]));
  await W("data/blob.txt", Buffer.from([0x68, 0x69, 0x00, 0x00, 0x01, 0x02, 0x68]));
  await W("data/config.json", JSON.stringify({ name: "demo", api_key: "abcd1234efgh5678", openrouter: SECRET_KEY }, null, 2));
  await W("images/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  await W("big/large.log", "x".repeat(99) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(50_000)); // ~5 MB
  await W("big/medium.txt", ("filler line\n").repeat(180_000) + "architecture at the very end\n");    // ~2 MB
  // Secrets and excluded folders: none of these may ever be listed, read or searched.
  await W(".env", "API_KEY=architecture-secret\n");
  await W(".env.local", "TOKEN=x\n");
  await W("secrets.json", "{\"architecture\": \"secret\"}\n");
  await W("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\narchitecture\n-----END OPENSSH PRIVATE KEY-----\n");
  await W("keys/server.pem", "architecture\n");
  await W(".git/config", "[core] architecture\n");
  await W("node_modules/pkg/index.js", "// architecture\n");
  await W(".ssh/known_hosts", "architecture\n");
  // Many small files for result limits and cancellation.
  await fs.mkdir(path.join(PROJ, "many"), { recursive: true });
  await Promise.all(Array.from({ length: 3000 }, (_, i) => fs.writeFile(path.join(PROJ, "many", `item-${String(i).padStart(4, "0")}.txt`), `needle ${i}\n`)));
}

// ── Scripted model ──────────────────────────────────────────────────────────

class ScriptedModel implements LanguageModel {
  readonly name = "scripted";
  constructor(private plan: unknown, private assessment: unknown = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "evidence shows it" }) {}
  async generateJson(req: StructuredRequest): Promise<unknown> {
    return structuredClone(req.purpose === "plan" ? this.plan : this.assessment);
  }
}
const plan = (tool: string, input: Record<string, unknown>) => ({ intent: "task", goal: "g", successCriteria: ["shown"], steps: [{ id: "s1", description: tool, tool, input }] });

async function main(): Promise<void> {
  await buildFixtures();
  const reg: ToolRegistry = createDefaultRegistry(PROJ);
  const ctx = (signal?: AbortSignal) => ({ taskId: "t", stepId: "s", signal: signal ?? new AbortController().signal, granted: DEFAULT_GRANTS, approvalGate: DENY_ALL_APPROVALS });
  const run = (tool: string, input: Record<string, unknown>, signal?: AbortSignal) => reg.invoke(tool, input, ctx(signal));
  const out = (r: Awaited<ReturnType<typeof run>>) => r.outcome.output as any;
  const allText = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify(r.outcome);

  console.log("\n[1-3] search: normal, recursive, extension filter");
  {
    const r = await run("filesystem.search", { query: "report" });
    const names = out(r)?.matches.map((m: any) => m.path);
    check(r.status === "executed" && r.outcome.ok, "1. search by name succeeds", r.outcome.error);
    check(JSON.stringify(names) === JSON.stringify(["docs/reports/2026-q2-report.md", "docs/reports/2026-q3-report.md"]), "1. finds exactly the two reports, in path order", names);
    const flat = await run("filesystem.search", { query: "report", recursive: false });
    check(out(flat).matches.length === 0, "2. recursive:false does not descend into subfolders", out(flat).matches);
    const fromDocs = await run("filesystem.search", { query: "report", path: "docs/reports" });
    check(out(fromDocs).matches.length === 2 && out(fromDocs).path === "docs/reports", "2. search can start in a subfolder");
    const pdfs = await run("filesystem.search", { extension: "pdf" });
    check(JSON.stringify(out(pdfs).matches.map((m: any) => m.path)) === JSON.stringify(["docs/manual.pdf", "reports/annual-2025.pdf"]), "3. extension filter finds both PDFs (any depth)", out(pdfs).matches);
    check((await run("filesystem.search", { extension: ".PDF" })).outcome.output && out(await run("filesystem.search", { extension: ".PDF" })).matches.length === 2, "3. extension is case-insensitive and may start with a dot");
    const latest = await run("filesystem.search", { query: "report", sort: "modified" });
    check(out(latest).matches[0].path === "docs/reports/2026-q3-report.md", "search sort:modified puts the newest first");
    const two = await run("filesystem.search", { query: "q3 report" });
    check(out(two).matches.length === 1 && out(two).matches[0].name === "2026-q3-report.md", "a multi-word query needs every word in the name");
    const a = JSON.stringify(out(await run("filesystem.search", { extension: "md" })).matches.map((m: any) => m.path));
    const b = JSON.stringify(out(await run("filesystem.search", { extension: "md" })).matches.map((m: any) => m.path));
    check(a === b, "ordering is deterministic across runs");
  }

  console.log("\n[4] metadata");
  {
    const r = await run("filesystem.metadata", { path: "docs/reports/2026-q3-report.md" });
    const o = out(r);
    check(r.outcome.ok && o.name === "2026-q3-report.md" && o.extension === "md" && o.type === "file" && o.kind === "text", "4. name, extension, type and kind", o);
    check(typeof o.size === "number" && o.size > 0 && o.modified.startsWith("2026-10-01") && !Number.isNaN(Date.parse(o.created)), "4. size and timestamps", o);
    const d = out(await run("filesystem.metadata", { path: "docs" }));
    check(d.type === "directory" && d.size === null, "4. a folder is described as a directory");
    const bare = await run("filesystem.metadata", { path: "2026-q3-report.md" });
    check(bare.outcome.ok && out(bare).path === "docs/reports/2026-q3-report.md", "4. a unique bare file name is found anywhere under the root", bare.outcome.error);
  }

  console.log("\n[5-6] read: whole file, line range, section, encodings");
  {
    const r = await run("filesystem.read", { path: "docs/architecture.md" });
    check(r.outcome.ok && out(r).startLine === 1 && out(r).endLine === 5 && out(r).text.startsWith("# Architecture"), "5. reads a text file with its line numbers", r.outcome);
    check(r.outcome.evidence.includes("docs/architecture.md") && r.outcome.evidence.includes("lines 1–5 of 5"), "5. evidence names the file and the line range", r.outcome.evidence);
    const range = await run("filesystem.read", { path: "docs/architecture.md", startLine: 3, endLine: 4 });
    check(out(range).text === "The architecture has three layers.\nNothing else here." && out(range).startLine === 3 && out(range).endLine === 4, "6. reads exactly lines 3–4", out(range));
    const intro = await run("filesystem.read", { path: "docs/reports/2026-q3-report.md", heading: "Introduction" });
    check(intro.outcome.ok && out(intro).section === "1. Introduction" && out(intro).startLine === 3 && out(intro).endLine === 6, "6. a heading reads just that section", out(intro));
    check(!out(intro).text.includes("Results"), "6. the section stops at the next heading of the same rank");
    const results = await run("filesystem.read", { path: "docs/reports/2026-q3-report.md", heading: "results" });
    check(out(results).text.includes("2.1 Details") && !out(results).text.includes("Conclusion"), "6. a section includes its subsections");
    const past = await run("filesystem.read", { path: "docs/architecture.md", startLine: 4, endLine: 999 });
    check(out(past).endLine === 5, "6. a range past the end stops at the last line");
    const u16 = await run("filesystem.read", { path: "data/notes-utf16.txt" });
    check(u16.outcome.ok && out(u16).encoding === "utf-16le" && out(u16).text.startsWith("UTF-16 notes"), "UTF-16 LE with BOM is decoded", out(u16));
    const l1 = await run("filesystem.read", { path: "data/legacy-1252.txt" });
    check(l1.outcome.ok && out(l1).encoding === "windows-1252" && out(l1).text.startsWith("Café"), "invalid UTF-8 falls back to Windows-1252", out(l1));
    const nohead = await run("filesystem.read", { path: "docs/guide.md", heading: "Introduction" });
    check(!nohead.outcome.ok && /no section headed/.test(nohead.outcome.error ?? ""), "a missing section is an error, not the whole file");
    check(findSection(["Title", "=====", "text", "Other", "=====", "x"], "title")?.end === 3 && findSection(["Title", "=====", "text", "Sub", "-----", "x"], "title")?.end === 6, "setext headings are understood, with their ranks");
  }

  console.log("\n[7] find_text");
  {
    const r = await run("filesystem.find_text", { query: "architecture" });
    const m = out(r).matches.map((x: any) => `${x.path}:${x.line}`);
    check(r.outcome.ok, "7. content search succeeds", r.outcome.error);
    check(m.includes("docs/architecture.md:1") && m.includes("docs/architecture.md:3") && m.includes("docs/architecture.md:5"), "7. returns exact line numbers, case-insensitive", m);
    check(m.includes("docs/reports/2026-q3-report.md:4") && m.includes("data/notes-utf16.txt:1") && m.includes("data/legacy-1252.txt:1"), "7. finds it in every text encoding", m);
    check(out(r).matches.find((x: any) => x.path === "docs/architecture.md" && x.line === 3)?.text === "The architecture has three layers.", "7. returns the exact matching line");
    check(out(r).skipped.tooLarge >= 1 && !m.some((x: string) => x.startsWith("big/medium.txt")), "7. files over the scan limit are skipped and counted", out(r).skipped);
    const docsOnly = await run("filesystem.find_text", { query: "architecture", path: "docs" });
    check(out(docsOnly).matches.every((x: any) => x.path.startsWith("docs/")), "7. path limits the search to a folder");
    const mdOnly = await run("filesystem.find_text", { query: "architecture", extension: "txt" });
    check(out(mdOnly).matches.every((x: any) => x.path.endsWith(".txt")), "7. extension filter applies to content search");
    check(!m.some((x: string) => x.includes("blob")), "7. binary content is never searched");
  }

  console.log("\n[8] path traversal and alternative argument forms");
  {
    const attempts: [string, Record<string, unknown>][] = [
      ["..", { path: ".." }],
      ["../outside", { path: "../outside/private-notes.md" }],
      ["docs/../../outside", { path: "docs/../../outside/private-notes.md" }],
      ["backslash ..", { path: "..\\outside\\private-notes.md" }],
      ["absolute outside", { path: path.join(OUTSIDE, "private-notes.md") }],
      ["absolute system file", { path: "C:\\Windows\\win.ini" }],
      ["extended-length", { path: "\\\\?\\" + path.join(OUTSIDE, "private-notes.md") }],
      ["device namespace", { path: "\\\\.\\C:\\Windows\\win.ini" }],
      ["UNC", { path: "\\\\localhost\\c$\\Windows\\win.ini" }],
      ["forward-slash UNC", { path: "//localhost/c$/Windows/win.ini" }],
      ["file URL", { path: "file:///C:/Windows/win.ini" }],
      ["drive-relative", { path: "C:Windows\\win.ini" }],
      ["alternate data stream", { path: "docs/architecture.md:secret" }],
      ["reserved device", { path: "CON" }],
      ["reserved device with extension", { path: "docs/nul.txt" }],
      ["trailing dot", { path: ".env." }],
      ["trailing space", { path: "docs/architecture.md " }],
      ["wildcard", { path: "docs/*.md" }],
      ["control character", { path: "docs/arch\u0000itecture.md" }],
      ["short-name outside", { path: "C:\\PROGRA~1\\desktop.ini" }],
    ];
    for (const [name, input] of attempts) {
      const r = await run("filesystem.read", input);
      check(!r.outcome.ok && !allText(r).includes("private"), `8. refused: ${name}`, r.outcome);
    }
    check((await run("filesystem.read", { path: ["docs/architecture.md"] })).status === "invalid_input", "8. a non-string path is rejected by the schema");
    check((await run("filesystem.read", { path: "docs/architecture.md", extra: true })).status === "invalid_input", "8. unknown arguments are rejected by the schema");
    check((await run("filesystem.search", { path: "..", query: "secret" })).outcome.ok === false, "8. search cannot start outside the root");
    check((await run("filesystem.find_text", { path: path.join(OUTSIDE), query: "architecture" })).outcome.ok === false, "8. find_text cannot start outside the root");
    check(checkPathText("docs/a.md") === null && checkPathText("C:\\x\\a.md") === null, "8. ordinary relative and absolute forms pass the text check");
  }

  console.log("\n[9] symbolic link and junction escapes");
  {
    const junction = path.join(PROJ, "docs", "escape-junction");
    await fs.symlink(OUTSIDE, junction, "junction");
    const r = await run("filesystem.read", { path: "docs/escape-junction/private-notes.md" });
    check(!r.outcome.ok && /outside/.test(r.outcome.error ?? ""), "9. reading through a junction to outside the root is refused", r.outcome);
    const s = await run("filesystem.search", { query: "private" });
    check(out(s).matches.length === 0 && out(s).skippedLinks >= 1, "9. a walk does not enter a junction (and counts it)", out(s));
    const f = await run("filesystem.find_text", { query: "private" });
    check(out(f).matches.length === 0, "9. content search does not follow a junction");
    const startAt = await run("filesystem.find_text", { query: "private", path: "docs/escape-junction" });
    check(!startAt.outcome.ok, "9. a junction cannot be used as the starting folder");
    let fileLink = true;
    try {
      await fs.symlink(path.join(OUTSIDE, "private-notes.md"), path.join(PROJ, "docs", "link.md"), "file");
    } catch (err) {
      fileLink = false;
      notes.push(`file symbolic links not tested: creating one needs privilege on this machine (${(err as NodeJS.ErrnoException).code})`);
    }
    if (fileLink) {
      const l = await run("filesystem.read", { path: "docs/link.md" });
      check(!l.outcome.ok && /outside/.test(l.outcome.error ?? ""), "9. a file symbolic link to outside is refused");
    }
    await fs.rm(junction, { recursive: false, force: true }).catch(() => fs.rmdir(junction));
  }

  console.log("\n[10] secret and excluded files");
  {
    const all = await run("filesystem.search", {});
    const names = out(all).matches.map((m: any) => m.path);
    for (const hidden of [".env", ".env.local", "secrets.json", "id_rsa", "keys/server.pem", ".git/config", "node_modules/pkg/index.js", ".ssh/known_hosts"]) {
      check(!names.includes(hidden), `10. never listed: ${hidden}`);
    }
    for (const p of [".env", ".env.local", "secrets.json", "id_rsa", "keys/server.pem", ".git/config", "node_modules/pkg/index.js", ".ssh/known_hosts"]) {
      const r = await run("filesystem.read", { path: p });
      check(!r.outcome.ok && !allText(r).includes("architecture"), `10. never read: ${p}`, r.outcome);
    }
    const f = await run("filesystem.find_text", { query: "architecture" });
    const where = out(f).matches.map((m: any) => m.path);
    check(!where.some((p: string) => /^(\.env|secrets|id_rsa|keys\/|\.git\/|node_modules\/|\.ssh\/)/.test(p)), "10. content search never looks inside them", where);
    const cfg = await run("filesystem.read", { path: "data/config.json" });
    check(cfg.outcome.ok && out(cfg).redactions >= 2 && !allText(cfg).includes(SECRET_KEY) && !allText(cfg).includes("abcd1234efgh5678"), "10. credential values in ordinary files are redacted", out(cfg));
    check(redactSecrets("password = hunter22").text === "password = [REDACTED]", "10. assigned secrets are redacted, the key name kept");
  }

  console.log("\n[11-12] binary and large files");
  {
    const pdf = await run("filesystem.read", { path: "docs/manual.pdf" });
    check(!pdf.outcome.ok && /pdf file/.test(pdf.outcome.error ?? ""), "11. a PDF is refused as non-text", pdf.outcome.error);
    const png = await run("filesystem.read", { path: "images/logo.png" });
    check(!png.outcome.ok && /image/.test(png.outcome.error ?? ""), "11. an image is refused", png.outcome.error);
    const blob = await run("filesystem.read", { path: "data/blob.txt" });
    check(!blob.outcome.ok && /binary/.test(blob.outcome.error ?? ""), "11. binary content in a .txt file is refused", blob.outcome.error);
    check(decodeText(Buffer.from([0x41, 0x00, 0x42])).ok === false, "11. NUL bytes mean binary");
    const big = await run("filesystem.read", { path: "big/large.log" });
    check(!big.outcome.ok && /too large/.test(big.outcome.error ?? ""), "12. a file over the read limit is refused", big.outcome.error);
    const capped = await run("filesystem.read", { path: "big/medium.txt", maxBytes: 1024 });
    check(capped.outcome.ok && out(capped).truncated && Buffer.byteLength(out(capped).text) <= 1024, "12. maxBytes bounds what is returned", out(capped)?.endLine);
  }

  console.log("\n[13] result limits");
  {
    const s = await run("filesystem.search", { query: "item", maxResults: 5 });
    check(out(s).matches.length === 5 && out(s).totalMatches === 3000 && out(s).truncated, "13. search returns at most maxResults and says it is truncated", { n: out(s).matches.length, total: out(s).totalMatches });
    const f = await run("filesystem.find_text", { query: "needle", maxResults: 10 });
    check(out(f).matches.length === 10 && out(f).truncated && out(f).stoppedAt === "result limit", "13. find_text stops at maxResults", out(f).stoppedAt);
    check((await run("filesystem.search", { maxResults: 500 })).status === "invalid_input", "13. maxResults above 200 is rejected");
    const small = createDefaultRegistry(PROJ);
    void small;
    const limited = await (await import("../../agent/runtime/tools/filesystem")).createFilesystemTools({ workspaceRoot: PROJ, limits: { maxEntriesVisited: 100 } })[0]!
      .execute({ query: "item" }, { taskId: "t", stepId: "s", signal: new AbortController().signal });
    check(limited.ok && (limited.output as any).stoppedAt === "entry_limit" && /incomplete/.test(limited.evidence), "13. the walk stops at its entry limit and says results may be incomplete");
  }

  console.log("\n[14] cancellation");
  {
    const pre = new AbortController();
    pre.abort();
    check((await run("filesystem.search", { query: "item" }, pre.signal)).status === "cancelled", "14. an already-cancelled call never runs");
    const mid = new AbortController();
    const t0 = Date.now();
    const p = run("filesystem.find_text", { query: "never-present-term" }, mid.signal);
    setTimeout(() => mid.abort(), 15);
    const r = await p;
    check(r.status === "cancelled" || (!r.outcome.ok && /Cancelled/.test(r.outcome.error ?? "")), "14. cancelling during a content search stops it", r.status);
    check(Date.now() - t0 < 2000, "14. it stops promptly", Date.now() - t0);
  }

  console.log("\n[15-17] invalid paths, permission denied, missing files");
  {
    const missing = await run("filesystem.read", { path: "docs/missing.md" });
    check(!missing.outcome.ok && /No such file/.test(missing.outcome.error ?? ""), "17. a missing file is reported as missing", missing.outcome.error);
    check(!(await run("filesystem.metadata", { path: "nope/nothing.md" })).outcome.ok, "17. metadata of a missing file fails");
    check(!(await run("filesystem.search", { path: "no-such-folder" })).outcome.ok, "17. search in a missing folder fails");
    const amb = await run("filesystem.read", { path: "guide.md" });
    check(!amb.outcome.ok && /2 files are named guide.md/.test(amb.outcome.error ?? ""), "15. an ambiguous bare name is refused, with both candidates", amb.outcome.error);
    check(!(await run("filesystem.read", { path: "docs" })).outcome.ok, "15. reading a folder is refused");
    check(!(await run("filesystem.search", { path: "README.md" })).outcome.ok, "15. searching inside a file is refused");
    check((await run("filesystem.read", { path: "" })).status === "invalid_input", "15. an empty path is rejected");
    const locked = path.join(PROJ, "data", "locked.txt");
    await fs.writeFile(locked, "locked content\n");
    let denied = false;
    try {
      execFileSync("icacls", [locked, "/deny", `${os.userInfo().username}:(R)`], { stdio: "ignore" });
      denied = true;
    } catch { notes.push("permission-denied test skipped: icacls could not change the ACL"); }
    if (denied) {
      const r = await run("filesystem.read", { path: "data/locked.txt" });
      check(!r.outcome.ok && /Permission denied/i.test(r.outcome.error ?? "") && !allText(r).includes("locked content"), "16. a file the user cannot read gives a permission error", r.outcome.error);
      const f = await run("filesystem.find_text", { query: "locked content", path: "data" });
      check(f.outcome.ok && out(f).matches.length === 0 && out(f).skipped.unreadable >= 1, "16. content search skips and counts an unreadable file", out(f)?.skipped);
      execFileSync("icacls", [locked, "/remove:d", os.userInfo().username], { stdio: "ignore" });
    }
  }

  console.log("\n[roots] configured roots are never widened");
  {
    const r = await resolveRoots(PROJ, ["C:\\", "relative/folder", path.join(TMP, "nope"), process.env.SystemRoot ?? "C:\\Windows", process.env.USERPROFILE ?? "C:\\Users\\x", OUTSIDE]);
    check(r.roots.length === 2 && r.roots[0]!.label === "workspace" && r.roots[1]!.label === "outside", "an extra approved folder becomes a second root", r.roots);
    const reasons = r.rejected.map((x) => x.reason).join(" | ");
    check(r.rejected.length === 5 && /whole drive/.test(reasons) && /absolute/.test(reasons) && /does not exist/.test(reasons) && /Windows/.test(reasons) && /user profile/.test(reasons), "drives, relative paths, missing folders, the OS and the whole profile are refused", r.rejected);
    const twoRoots = createDefaultRegistry(PROJ, { fileRoots: [OUTSIDE] });
    const abs = await twoRoots.invoke("filesystem.read", { path: path.join(OUTSIDE, "private-notes.md") }, ctx());
    check(abs.outcome.ok, "a file in an approved extra root is readable by absolute path");
    const s = await twoRoots.invoke("filesystem.search", { path: OUTSIDE, query: "private" }, ctx());
    check(s.outcome.ok && (s.outcome.output as any).root === "outside" && s.outcome.evidence.includes("outside: private-notes.md"), "results name the root they came from");
  }

  console.log("\n[18] verification evidence: the verifier re-reads the filesystem");
  {
    const tools = reg;
    const spec = tools.get("filesystem.read")!;
    const input = { path: "docs/architecture.md", startLine: 3, endLine: 3 };
    const r = await run("filesystem.read", input);
    check(spec.check!(input, r.outcome).ok, "18. an honest read passes its postcondition");
    await fs.writeFile(path.join(PROJ, "docs", "architecture.md"), "# Architecture\n\nSomething different now.\n");
    check(!spec.check!(input, r.outcome).ok, "18. if the file no longer says it, the read fails verification");
    const fake = { ...r.outcome, output: { ...out(r), text: "Invented by a model" } };
    check(!spec.check!(input, fake).ok, "18. text the file does not contain fails verification");
    const fspec = tools.get("filesystem.find_text")!;
    const fin = { query: "three layers" };
    await fs.writeFile(path.join(PROJ, "docs", "architecture.md"), "# Architecture\n\nThe architecture has three layers.\nNothing else here.\nARCHITECTURE notes, upper case.\n");
    const fr = await run("filesystem.find_text", fin);
    check(fspec.check!(fin, fr.outcome).ok, "18. honest matches pass");
    const lie = { ...fr.outcome, output: { ...(fr.outcome.output as any), matches: [{ ...(fr.outcome.output as any).matches[0], line: 1 }] } };
    check(!fspec.check!(fin, lie).ok, "18. a match at a line that does not contain the term fails");
    const sspec = tools.get("filesystem.search")!;
    const sr = await run("filesystem.search", { query: "guide" });
    const ghost = { ...sr.outcome, output: { ...(sr.outcome.output as any), matches: [...(sr.outcome.output as any).matches, { ...(sr.outcome.output as any).matches[0], canonicalPath: path.join(PROJ, "ghost-guide.md"), path: "ghost-guide.md", name: "ghost-guide.md" }] } };
    check(!sspec.check!({ query: "guide" }, ghost).ok, "18. a listed file that does not exist fails");
  }

  console.log("\n[18] end to end through the runtime: grounding, domains, outcomes");
  {
    const runTask = async (objective: string, p: unknown, assessment?: unknown) =>
      new AgentRuntime({ model: new ScriptedModel(p, assessment), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "t1", objective });

    const pdf = await runTask("Find all PDF files in my authorized project directory", plan("filesystem.search", { extension: "pdf" }));
    check(pdf.outcome === "completed" && pdf.verification?.independentlyVerified, "18. 'Find all PDF files in my authorized project directory' completes", { o: pdf.outcome, v: pdf.verification });
    check(pdf.response.includes("docs/manual.pdf") && pdf.response.includes("reports/annual-2025.pdf"), "18. the answer names the real files", pdf.response);

    const latest = await runTask("Find the latest report and show its metadata", plan("filesystem.search", { query: "report", sort: "modified" }));
    check(latest.outcome === "completed", "18. 'Find the latest report and show its metadata' completes", { o: latest.outcome, v: latest.verification });
    check(/2026-q3-report\.md — [\d.]+ (B|KB), modified 2026-10-01/.test(latest.response), "18. the newest report comes first with size and dates", latest.response);

    const intro = await runTask("Read the introduction of docs/reports/2026-q3-report.md", plan("filesystem.read", { path: "docs/reports/2026-q3-report.md", heading: "introduction" }));
    check(intro.outcome === "completed" && intro.response.includes("lines 3–6") && intro.response.includes("rebuilt the architecture"), "18. reading a named section completes, with its line range and text", intro.response);

    const occ = await runTask("Find every occurrence of the term architecture in the project documentation", plan("filesystem.find_text", { query: "architecture", path: "docs" }));
    check(occ.outcome === "completed" && /docs\/architecture\.md:3: The architecture has three layers\./.test(occ.response), "18. content search completes with file:line evidence", occ.response);

    const vague = await runTask("Read the introduction of this report", plan("filesystem.read", { path: "docs/reports/2026-q3-report.md", heading: "introduction" }));
    check(vague.outcome !== "completed", "18. a read the request does not pin to a file can never be 'completed'", vague.outcome);

    // Superseded 2026-11-10: summarising is served by filesystem.summarize (extractive, verified). A raw read for a summary
    // request is no longer grounded, so it can never complete.
    const summary = await runTask("Summarize docs/reports/2026-q3-report.md", plan("filesystem.read", { path: "docs/reports/2026-q3-report.md" }));
    check(summary.outcome !== "completed" && summary.verification?.grounding.some((g) => g.status !== "grounded"), "18. a raw read for 'summarize' is not grounded and never completes (the summarize tool serves it)", { o: summary.outcome, g: summary.verification?.grounding });

    const wrongFile = await runTask("Read docs/guide.md", plan("filesystem.read", { path: "docs/architecture.md" }));
    check(wrongFile.outcome === "failed" && /not taken from the request/.test(wrongFile.response), "18. a file the request did not name is never read", wrongFile.response);

    const ghost = await runTask("Read docs/missing.md", plan("filesystem.read", { path: "docs/missing.md" }));
    check(ghost.outcome === "failed" && !/Done/.test(ghost.response), "18. the agent never claims to have read a file it could not read", ghost.response);

    const dishonest = await runTask("Read docs/guide.md", plan("filesystem.read", { path: "docs/guide.md" }), { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "I read it all" });
    check(dishonest.outcome === "completed" && dishonest.response.includes("How to use the demo."), "18. the response is the file's own text, not the model's account of it", dishonest.response);

    const wrongExt = await runTask("Find all PDF files in my authorized project directory", plan("filesystem.search", { extension: "md" }));
    check(wrongExt.outcome === "failed", "18. an extension the request did not ask for is not executed", wrongExt.outcome);

    const doms = argumentDomainsFor(createDefaultRegistry(PROJ), "Find all PDF files in my authorized project directory");
    check(checkArguments(doms, "filesystem.search", { extension: "pdf", path: "C:\\Windows" }) !== null, "18. a path the request did not name is refused before execution");
  }

  console.log("\n[offer] the planner offers the tools the request checks recognise");
  {
    const { Planner } = await import("../../agent/runtime/planner");
    const { Brain } = await import("../../agent/runtime/brain");
    const r8 = createDefaultRegistry(PROJ);
    const p = new Planner(new Brain(new ScriptedModel(null), 1000), r8);
    const names = (o: string) => p.toolsFor(o, DEFAULT_GRANTS).map((t) => t.name).sort().join(",");
    check(names("Find all PDF files in my authorized project directory") === "filesystem.search", "a file search is offered only filesystem.search", names("Find all PDF files in my authorized project directory"));
    check(names("Read the introduction of docs/reports/2026-q3-report.md") === "filesystem.read", "a named read is offered only filesystem.read");
    check(names("What is (17+25)*2?") === "math.evaluate", "arithmetic is offered only math.evaluate");
    check(names("What time is it and how much memory do I have?") === "system.info,system.time", "a two-part request is offered both tools");
    check(names("List the files in the docs folder") === "workspace.list_dir", "a listing is offered only workspace.list_dir");
    // Phase 7A correction: with nothing recognised, tools that could not concern the request (file tools for a
    // request with no file wording) or whose required argument it forbids are not offered. The result is still at most unverified.
    check(names("Tell me a joke") === "math.evaluate,system.info,system.time,workspace.list_dir", "with nothing recognised, every tool that could concern the request is offered", names("Tell me a joke"));
    const all = new Planner(new Brain(new ScriptedModel(null), 1000), r8, { requestToolOffer: false });
    check(all.toolsFor("What is (17+25)*2?", DEFAULT_GRANTS).length === 10, "the research ablation offers every tool (10 since summarize + plan_organize)");
  }

  console.log("\n[fix-A] 0.5B regression: tool offer and time-zone argument");
  {
    const { Planner } = await import("../../agent/runtime/planner");
    const { Brain } = await import("../../agent/runtime/brain");
    const r8 = createDefaultRegistry(PROJ);
    const p = new Planner(new Brain(new ScriptedModel(null), 1000), r8);
    const names = (o: string) => p.toolsFor(o, DEFAULT_GRANTS).map((t) => t.name).sort().join(",");
    const V3 = "math.evaluate,system.info,system.time,workspace.list_dir";
    check(names("How many hours are in a week?") === V3, "A1 an unrecognised paraphrase is offered the four Phase 4 tools, not the file tools", names("How many hours are in a week?"));
    check(names("What is seventeen times three?") === V3, "A2 paraphrased arithmetic is offered the four Phase 4 tools", names("What is seventeen times three?"));
    check(names("What does the folder hold?").includes("filesystem.search"), "A3 an unrecognised request with file wording still gets the file tools that can run");
    check(!names("What does the folder hold?").includes("filesystem.read"), "A4 a read is not offered when no file is named (its path would be forbidden)");
    const tz = argumentDomainsFor(r8, "What does the clock say in New York?")["system.time"]?.timeZone;
    check(tz?.kind === "enum" && tz.optional === false && tz.values.includes("America/New_York"), "A5 a named zone is required, not optional", tz);
    check(checkArguments(argumentDomainsFor(r8, "What does the clock say in New York?"), "system.time", {}) !== null, "A6 omitting the named zone is refused before execution");
    check(argumentDomainsFor(r8, "What time is it?")["system.time"]?.timeZone?.kind === "forbidden", "A7 no zone named → timeZone still forbidden (local time)");
    const runT = (o: string, pl: unknown) => new AgentRuntime({ model: new ScriptedModel(pl), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "tz", objective: o });
    const omitted = await runT("What does the clock say in New York?", plan("system.time", {}));
    check(omitted.outcome !== "completed" && omitted.steps.every((s) => s.status !== "succeeded"), "A8 a plan omitting the named zone never runs and never completes", { o: omitted.outcome, r: omitted.response });
    const ny = await runT("What does the clock say in New York?", plan("system.time", { timeZone: "America/New_York" }));
    check(ny.outcome === "completed", "A9 the same request with the named zone still completes", { o: ny.outcome, r: ny.response });
    const ablation = new Planner(new Brain(new ScriptedModel(null), 1000), r8, { requestToolOffer: false });
    check(ablation.toolsFor("How many hours are in a week?", DEFAULT_GRANTS).length === 10, "A10 the research ablation still offers every tool");
  }

  console.log("\n[fix-B] no arbitrary file selection");
  {
    let modelCalls = 0;
    class CountingModel implements LanguageModel {
      readonly name = "counting";
      constructor(private readonly p: unknown, private readonly a: unknown = { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" }) {}
      async generateJson(req: StructuredRequest): Promise<unknown> { modelCalls++; return structuredClone(req.purpose === "plan" ? this.p : this.a); }
    }
    const runB = (objective: string, p: unknown, history?: { objective: string; outcome: "completed"; response: string }[]) =>
      new AgentRuntime({ model: new CountingModel(p), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "b", objective, history });
    const q3 = plan("filesystem.read", { path: "docs/reports/2026-q3-report.md", heading: "introduction" });
    const Q3_TEXT = "rebuilt the architecture";
    const asks = async (label: string, objective: string, noun: string, p: unknown = q3) => {
      modelCalls = 0;
      const r = await runB(objective, p);
      check(r.outcome === "refused" && r.steps.length === 0 && new RegExp(`^Which ${noun} do you mean\\?`).test(r.response) && modelCalls === 0,
        `${label} '${objective}' → asks which ${noun}, runs nothing, asks the model nothing`, { o: r.outcome, r: r.response, steps: r.steps.length, modelCalls });
      check(!r.response.includes(Q3_TEXT) && !r.response.includes("How to use"), `${label} no file content is shown before the file is named`);
    };
    await asks("B1 ambiguous report:", "Read the introduction of this report", "report");
    await asks("B2 ambiguous document:", "What does the document say?", "document");
    await asks("B2b section in an unnamed document:", "Read the conclusion section in the document", "document");
    await asks("B2c unnamed summary:", "Summarize the report using its actual contents", "report");
    await asks("B2d recency is not a name:", "Find the latest report and read it", "report", plan("filesystem.search", { query: "report", sort: "modified" }));
    await asks("B2e unnamed metadata:", "How big is this file?", "file");

    const multi = await runB("Read guide.md", plan("filesystem.read", { path: "guide.md" }));
    check(multi.outcome !== "completed" && /2 files are named guide\.md: data\/guide\.md, docs\/guide\.md\. Which one do you mean\?/.test(multi.response),
      "B3 several files with the named name → the user is asked to choose", multi.response);
    check(!multi.response.includes("How to use the demo.") && !multi.response.includes("Data guide"), "B3 neither candidate's content is shown");

    const bare = await runB("Read architecture.md", plan("filesystem.read", { path: "architecture.md" }));
    check(bare.outcome === "completed" && bare.response.includes("The architecture has three layers."), "B4 an explicit unique file name is read and completes", { o: bare.outcome, r: bare.response });
    const explicit = await runB("Read docs/guide.md", plan("filesystem.read", { path: "docs/guide.md" }));
    check(explicit.outcome === "completed" && explicit.response.includes("How to use the demo."), "B5 an explicit path is read and completes", explicit.outcome);
    check((await runB("Read the contents of the file .env.local", plan("filesystem.read", { path: ".env.local" }))).outcome !== "completed", "B5b a named secret file is still never read");

    modelCalls = 0;
    const prior = await runB("Read the introduction of this report", q3,
      [{ objective: "Read docs/reports/2026-q3-report.md", outcome: "completed", response: "Done." }]);
    check(prior.outcome === "refused" && /^Which report do you mean\?/.test(prior.response) && prior.steps.length === 0,
      "B6 a previously named file is NOT reused from history (not reliably established): the user is asked", { o: prior.outcome, r: prior.response });

    const arbitrary = await runB("What does it say in the introduction?", q3);
    check(arbitrary.outcome !== "completed" && arbitrary.steps.every((s) => s.status !== "succeeded") && !arbitrary.response.includes(Q3_TEXT),
      "B7 a file chosen by the model for a request that names none is never read", { o: arbitrary.outcome, r: arbitrary.response });
    const doms = argumentDomainsFor(createDefaultRegistry(PROJ), "What does it say in the introduction?");
    check(checkArguments(doms, "filesystem.read", { path: "docs/reports/2026-q3-report.md" }) !== null, "B8 read: any path is refused when the request names no file");
    check(checkArguments(doms, "filesystem.metadata", { path: "docs/guide.md" }) !== null, "B9 metadata: any path is refused when the request names no file");
    const anyTerm = await runB("Show me what is interesting in the docs", plan("filesystem.find_text", { query: "architecture" }));
    check(anyTerm.outcome !== "completed" && !anyTerm.response.includes("three layers"), "B10 a search term chosen by the model is never searched", { o: anyTerm.outcome, r: anyTerm.response });
    check(checkArguments(argumentDomainsFor(createDefaultRegistry(PROJ), "Show me what is interesting in the docs"), "filesystem.find_text", { query: "architecture" }) !== null,
      "B11 find_text: the query is refused when the request names no term");
    check(readClarification("Find the latest report and show its metadata") === null, "B12 a search for the latest report (names only) is not blocked");
  }

  // Superseded 2026-11-10: a summary is now EXTRACTIVE (filesystem.summarize): every line it shows is quoted from the file and
  // re-checked by its postcondition, so it can complete. What stays: no model-written claim is ever shown.
  console.log("\n[fix-C] extractive summary verified; model claims never shown");
  {
    const runC = (objective: string, p: unknown, assessment?: unknown) =>
      new AgentRuntime({ model: new ScriptedModel(p, assessment), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "c", objective });
    const SUM = "Summarize docs/reports/2026-q3-report.md";
    const sumQ3 = plan("filesystem.summarize", { path: "docs/reports/2026-q3-report.md" });
    const ok = await runC(SUM, sumQ3);
    check(ok.outcome === "completed" && ok.verification?.independentlyVerified === true && ok.response.includes('"Latency fell by half."') && ok.response.includes("line 8"),
      "C1 an extractive summary completes: quoted key sentences with their line numbers, independently verified", { o: ok.outcome, r: ok.response });
    check(/Outline: Q3 Report \(line 1\)/.test(ok.response) && !/^Not verified: the summary/m.test(ok.response), "C1 the outline comes from the file's headings");

    const lies = await runC(SUM, sumQ3, { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "The report says revenue tripled and the CEO resigned." });
    check(!/revenue tripled|CEO/.test(lies.response), "C2 a model's own claims about the file are never shown", lies.response);

    const rawRead = await runC(SUM, plan("filesystem.read", { path: "docs/reports/2026-q3-report.md" }));
    check(rawRead.outcome !== "completed", "C3 a raw read for a summary request is not grounded and never completes", rawRead.outcome);
    const conclusion = await runC("Summarize the conclusion of docs/reports/2026-q3-report.md", plan("filesystem.summarize", { path: "docs/reports/2026-q3-report.md", heading: "conclusion" }));
    check(conclusion.outcome === "completed" && /"Ship it\."|Conclusion/.test(conclusion.response) && !conclusion.response.includes("rebuilt the architecture"),
      "C3b 'summarize the conclusion of X' summarises only that section", { o: conclusion.outcome, r: conclusion.response });
    const wrongPart = await runC("Summarize the conclusion of docs/reports/2026-q3-report.md", plan("filesystem.summarize", { path: "docs/reports/2026-q3-report.md", heading: "introduction" }));
    check(wrongPart.outcome !== "completed" && !wrongPart.response.includes("rebuilt the architecture"), "C3c summarising a different section than the one asked for is refused", { o: wrongPart.outcome, r: wrongPart.response });

    const noJudge = await runC(SUM, sumQ3, "not an assessment");
    check(noJudge.outcome === "unverified" && noJudge.verification?.criteriaSatisfied === null, "C4 semantic check unavailable: never completed (fail closed)", noJudge.outcome);
  }

  console.log("\n[S] filesystem.summarize");
  {
    const runS = (objective: string, input: Record<string, unknown>) =>
      new AgentRuntime({ model: new ScriptedModel(plan("filesystem.summarize", input)), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "s", objective });
    const folder = await runS("Give me an overview of the docs folder", { path: "docs" });
    check(folder.outcome === "completed" && /Folder docs: \d+ file\(s\)/.test(folder.response) && /By kind:/.test(folder.response) && folder.response.includes("2026-q3-report.md"),
      "S1 a folder overview: counts by kind, newest and largest files", { o: folder.outcome, r: folder.response });
    const csvPath = "data/sales.csv";
    await W(csvPath, "region,month,revenue\nnorth,jan,10\nsouth,jan,12\n");
    const csv = await runS(`Summarize ${csvPath}`, { path: csvPath });
    check(csv.outcome === "completed" && /2 data row\(s\) and 3 column\(s\): region, month, revenue/.test(csv.response), "S2 a CSV: columns and row count", csv.response);
    const json = await runS("Summarize data/config.json", { path: "data/config.json" });
    check(json.outcome === "completed" && /top-level key\(s\): name, api_key, openrouter/.test(json.response) && !json.response.includes(SECRET_KEY) && !json.response.includes("abcd1234efgh5678"),
      "S3 a JSON file: its keys, never secret values", json.response);
    const pdfS = await runS("Summarize docs/manual.pdf", { path: "docs/manual.pdf" });
    check(pdfS.outcome !== "completed" && /only text files can be summarised/.test(pdfS.response), "S4 a PDF is refused honestly (no text extraction)", pdfS.response);
    const other = await runS("Summarize docs/guide.md", { path: "docs/architecture.md" });
    check(other.outcome !== "completed" && !other.response.includes("three layers"), "S5 the model cannot summarise a file the request did not name", other.response);
    const env = await runS("Summarize .env", { path: ".env" });
    check(env.outcome !== "completed" && !env.response.includes("architecture-secret"), "S6 a secret file is never summarised", env.response);
    const three = await runS("Summarize docs/reports/2026-q3-report.md in 2 sentences", { path: "docs/reports/2026-q3-report.md", maxSentences: 2 });
    check(three.outcome === "completed" && ((three.steps[0]?.outcome?.output as any)?.keySentences?.length ?? 0) === 2, "S7 'in 2 sentences' gives exactly 2 key sentences", three.response);
    // Postcondition independence: a summary whose quotes no longer match the file fails its check.
    const { createSummarizeTool } = await import("../../agent/runtime/tools/fileSummary");
    const { FileAccess } = await import("../../agent/runtime/tools/filesystem");
    const acc = new FileAccess({ workspaceRoot: PROJ });
    const tool = createSummarizeTool(acc);
    const res = await tool.execute({ path: "docs/architecture.md" }, { taskId: "x", stepId: "x", signal: new AbortController().signal } as any);
    const forged = { ...res, output: { ...res.output!, keySentences: [{ line: 3, text: "The architecture has four layers." }] } };
    check(res.ok && tool.check!({ path: "docs/architecture.md" }, res).ok && !tool.check!({ path: "docs/architecture.md" }, forged).ok, "S8 the postcondition re-reads the file: a quote that is not in it fails");
    const unnamed = clarificationFor(createDefaultRegistry(PROJ), "Summarize the report using its actual contents");
    check(unnamed !== null && /^Which report do you mean\?/.test(unnamed), "S9 an unnamed file is asked about, not chosen");

    // Dotfiles (real-HUD finding 2026-11-10, results/summarize-hud/live-20261110T192424 S5): "Summarize .env" was not
    // recognised as naming a file, so no facet existed and the model ran unrelated tools (UNVERIFIED). Now it is a file
    // request, and fileAccess still refuses every secret name.
    console.log("\n[D] dotfile requests");
    await W("docs/.env", "API_KEY=docs-dotenv-secret\n");
    await W(".eslintrc.json", "{\"root\": true}\n");
    check(JSON.stringify(requestedFiles("Summarize .env")) === '[".env"]' && JSON.stringify(requestedFiles("Summarize the .env file")) === '[".env"]'
      && JSON.stringify(requestedFiles("Summarize docs/.env")) === '["docs/.env"]' && JSON.stringify(requestedFiles("Summarize .env.")) === '[".env"]'
      && JSON.stringify(requestedFiles("Summarize .eslintrc.json")) === '[".eslintrc.json"]',
      "D1 bare and pathed dotfile names are named files", [requestedFiles("Summarize .env"), requestedFiles("Summarize the .env file"), requestedFiles("Summarize docs/.env")]);
    check(requestedFiles("Summarize the .NET project notes").length === 0 && requestedFiles("Wait .5 seconds").length === 0 && requestedFiles("wait... ok").length === 0,
      "D2 '.NET', '.5' and an ellipsis are not files");
    const reg = createDefaultRegistry(PROJ);
    for (const o of ["Summarize .env", "Summarize the .env file", "Summarize docs/.env"]) {
      const f = detectFacets(reg, o).map((x) => x.id);
      check(f.length === 1 && f[0]!.startsWith("summarize:") && f[0]!.includes(".env"), `D3 "${o}" is a summarise request for that file`, f);
    }
    const refusedSecret = async (o: string, p: string, secret: string) => {
      const r = await runS(o, { path: p });
      return { ok: r.outcome !== "completed" && /excluded/.test(r.response) && !r.response.includes(secret), o: r.outcome, r: r.response };
    };
    for (const [o, p, s] of [["Summarize .env", ".env", "architecture-secret"], ["Summarize the .env file", ".env", "architecture-secret"],
      ["Summarize docs/.env", "docs/.env", "docs-dotenv-secret"], ["Summarize .env.local", ".env.local", "TOKEN=x"],
      ["Summarize secrets.json", "secrets.json", "\"architecture\": \"secret\""], ["Summarize keys/server.pem", "keys/server.pem", "architecture\n"]] as const) {
      const x = await refusedSecret(o, p, s);
      check(x.ok, `D4 "${o}": refused as excluded, not completed, content never shown`, x);
    }
    const improvised = await new AgentRuntime({ model: new ScriptedModel(plan("system.info", {})), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "d5", objective: "Summarize .env" });
    check(improvised.outcome !== "completed" && !improvised.response.includes("architecture-secret"), "D5 an unrelated tool for 'Summarize .env' can never complete it", { o: improvised.outcome });
    const eslint = await runS("Summarize .eslintrc.json", { path: ".eslintrc.json" });
    check(eslint.outcome === "completed" && /top-level key\(s\): root/.test(eslint.response), "D6 an ordinary (non-secret) text dotfile is summarised as before", { o: eslint.outcome, r: eslint.response });
    const readEnv = await new AgentRuntime({ model: new ScriptedModel(plan("filesystem.read", { path: ".env" })), registry: createDefaultRegistry(PROJ), granted: DEFAULT_GRANTS }).run({ taskId: "d7", objective: "Read .env" });
    check(readEnv.outcome !== "completed" && /excluded/.test(readEnv.response) && !readEnv.response.includes("architecture-secret"), "D7 'Read .env' is refused as excluded too", { o: readEnv.outcome, r: readEnv.response });
  }

  console.log("\n[detectors] request understanding");
  {
    check(JSON.stringify(requestedExtensions("Find all PDF files")) === '["pdf"]', "PDF files → pdf");
    check(requestedExtensions("open report.md").length === 0, "a file name's extension is not an extension filter");
    check(JSON.stringify(requestedFiles("Read the introduction of docs/reports/2026-q3-report.md")) === '["docs/reports/2026-q3-report.md"]', "file paths are extracted");
    check(requestedFiles("e.g. read it").length === 0 && requestedFiles("version 3.5 notes").length === 0, "abbreviations and numbers are not files");
    check(textQuery("Find every occurrence of the term architecture in the project documentation") === "architecture", "the search term is extracted");
    check(textQuery('Search the docs for "offline mode" mentions') === "offline mode", "a quoted phrase is the search term");
    check(JSON.stringify(nameTerms("Find the latest report and show its metadata")) === '["report"]', "name terms exclude the search vocabulary");
    check(isFileSearch("Find all PDF files in my authorized project directory") && !isTextSearch("Find all PDF files in my authorized project directory"), "a file search is not a content search");
    check(!isFileSearch("Search the web for today's weather"), "web searches are not file searches");
    check(isReadRequest("Read the introduction of docs/a.md") && !isMetadataRequest("Read the introduction of docs/a.md"), "a read is not a metadata request");
    check(isMetadataRequest("When was docs/a.md last modified?"), "a metadata question is recognised");
  }
}

main()
  .catch((err) => { failed++; console.error("UNCAUGHT", err); })
  .finally(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
    for (const n of notes) console.log("NOTE: " + n);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
