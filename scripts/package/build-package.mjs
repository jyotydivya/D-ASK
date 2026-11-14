#!/usr/bin/env node
// Builds the D-ASK desktop package: Release daemon and HUD, frontend, compiled agent host, pinned Node runtime,
// pinned llama-server, and a hash manifest the daemon checks before every host start.
//
//   node scripts/package/build-package.mjs [--out <dir>] [--models <id,id>] [--skip-build]
//   node scripts/package/build-package.mjs --verify [--out <dir>]
//
// The folder layout mirrors the repository on purpose: the daemon and the HUD each allow only the other's exact
// path relative to themselves, and this keeps that check unchanged. Downloads happen only when this script is run
// explicitly, and the Node archive is checked against the pinned hash in node-runtime.json. Models are linked
// when possible, never overwritten, and verified by the supervisor before each load.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argValue = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = path.resolve(argValue("out") ?? path.join(ROOT, "dist", "desktop", "D-ASK"));
const VERIFY_ONLY = process.argv.includes("--verify");
const SKIP_BUILD = process.argv.includes("--skip-build");
const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/package/node-runtime.json"), "utf8"));
const artifacts = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/runtime/inference/artifacts.json"), "utf8"));

const MANIFEST = "package-manifest.json";
const NODE_REL = "runtime/node/node.exe";
const ENTRY_REL = "dist/agent-host/agent/host/stdioHost.js";
const DAEMON_DIR = "src/DAsk.Daemon/bin/Release/net8.0";
const HUD_REL = "src/hud-native/target/release/hud-native.exe";

const log = (s) => console.log(`[package] ${s}`);
const fail = (s) => { console.error(`[package] ERROR: ${s}`); process.exit(1); };

function run(cmd, args, cwd = ROOT) {
  log(`${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && !cmd.includes("\\") });
  if (r.status !== 0) fail(`${cmd} exited with ${r.status}`);
}

function sha256(file) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(OUT, p).split(path.sep).join("/");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/** A hard link keeps gigabytes of model weights from being duplicated; falls back to a copy across volumes. */
function linkOrCopy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) return;
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

function modelFile(id) {
  const m = artifacts.models.find((x) => x.id === id);
  if (!m) fail(`Unknown model id ${id}`);
  return m;
}

function verifyManifest() {
  const manifestPath = path.join(OUT, MANIFEST);
  if (!fs.existsSync(manifestPath)) fail(`No manifest at ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const settings = JSON.parse(fs.readFileSync(path.join(OUT, DAEMON_DIR, "appsettings.json"), "utf8"));
  const expected = settings.AgentHost?.ManifestSha256;
  if (sha256(manifestPath).toLowerCase() !== String(expected).toLowerCase()) fail("Manifest hash does not match the daemon's settings");
  let bad = 0;
  for (const f of manifest.files) {
    const full = path.join(OUT, f.path);
    if (!fs.existsSync(full)) { console.error(`missing: ${f.path}`); bad++; continue; }
    if (sha256(full) !== f.sha256) { console.error(`changed: ${f.path}`); bad++; }
  }
  if (bad) fail(`${bad} file(s) differ from the manifest`);
  log(`verified ${manifest.files.length} files against the manifest; Node ${manifest.nodeVersion}`);
  const r = spawnSync(path.join(OUT, NODE_REL), ["--version"], { encoding: "utf8" });
  if (r.stdout.trim() !== `v${pinned.version}`) fail(`Packaged Node reports ${r.stdout.trim()}, expected v${pinned.version}`);
  log(`packaged Node runs and reports ${r.stdout.trim()}`);
}

async function ensureNode() {
  const cacheDir = path.join(ROOT, "local-inference", "node");
  const zip = path.join(cacheDir, path.basename(new URL(pinned.url).pathname));
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(zip)) {
    log(`downloading ${pinned.url}`);
    const res = await fetch(pinned.url);
    if (!res.ok) fail(`Node download failed: HTTP ${res.status}`);
    const tmp = `${zip}.partial`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const got = sha256(tmp);
    if (got !== pinned.sha256) { fs.unlinkSync(tmp); fail(`Node archive hash ${got} does not match the pinned ${pinned.sha256}`); }
    fs.renameSync(tmp, zip);
  }
  const got = sha256(zip);
  if (got !== pinned.sha256) fail(`Cached Node archive hash ${got} does not match the pinned ${pinned.sha256}`);
  log(`Node archive matches the pinned SHA-256 ${pinned.sha256}`);

  const extract = fs.mkdtempSync(path.join(os.tmpdir(), "dask-node-"));
  run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extract}' -Force`]);
  const inner = path.join(extract, `node-v${pinned.version}-win-x64`);
  fs.mkdirSync(path.join(OUT, "runtime", "node"), { recursive: true });
  fs.copyFileSync(path.join(inner, "node.exe"), path.join(OUT, NODE_REL));
  fs.copyFileSync(path.join(inner, "LICENSE"), path.join(OUT, "runtime", "node", "LICENSE"));
}

async function build() {
  if (fs.existsSync(path.join(OUT, MANIFEST)) && !process.argv.includes("--replace")) {
    fail(`${OUT} already holds a package. Use another --out, or pass --replace to overwrite its files.`);
  }
  if (!SKIP_BUILD) {
    run("npm", ["run", "build:agent-host"]);
    run("npm", ["run", "build"]);
    run("cargo", ["build", "--release", "--bin", "hud-native", "--bin", "dask-ocr"], path.join(ROOT, "src", "hud-native"));
    run("dotnet", ["publish", "src/DAsk.Daemon/DAsk.Daemon.csproj", "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-o", path.join(OUT, DAEMON_DIR), "--nologo", "-v", "q"]);
  }

  fs.mkdirSync(OUT, { recursive: true });
  await ensureNode();

  // Agent host: compiled output only, without test helpers.
  fs.rmSync(path.join(OUT, "dist", "agent-host"), { recursive: true, force: true });
  copyDir(path.join(ROOT, "dist", "agent-host"), path.join(OUT, "dist", "agent-host"));
  const stray = walk(path.join(OUT, "dist", "agent-host")).filter((f) => /[\\/]tests[\\/]/.test(f));
  if (stray.length) fail(`Test files in the host output: ${stray.map(rel).join(", ")}. Rebuild with npm run build:agent-host in a clean dist/agent-host.`);

  // Local memory (SQLite): the host loads better-sqlite3 from <package>/node_modules. Only what Windows x64 needs is shipped: the N-API prebuilt binary
  // (stable across Node versions), the JavaScript, and the licence. It is covered by the manifest below, so a changed copy stops the host like any other host file.
  const sqliteSrc = path.join(ROOT, "node_modules", "better-sqlite3");
  const sqliteOut = path.join(OUT, "node_modules", "better-sqlite3");
  if (!fs.existsSync(path.join(sqliteSrc, "prebuilds", "win32-x64.node"))) fail("better-sqlite3 win32-x64 prebuilt binary is missing; run npm install (local memory cannot be packaged without it)");
  fs.rmSync(sqliteOut, { recursive: true, force: true });
  fs.mkdirSync(path.join(sqliteOut, "prebuilds"), { recursive: true });
  for (const f of ["package.json", "LICENSE"]) fs.copyFileSync(path.join(sqliteSrc, f), path.join(sqliteOut, f));
  copyDir(path.join(sqliteSrc, "lib"), path.join(sqliteOut, "lib"));
  fs.copyFileSync(path.join(sqliteSrc, "prebuilds", "win32-x64.node"), path.join(sqliteOut, "prebuilds", "win32-x64.node"));
  // Fail the build unless the PACKAGED Node can open a database with the shipped copy (ABI and FTS5 checked here, not assumed).
  // (run after the Node runtime is in place; see below)

  // Browser automation: playwright-core (pure JavaScript, no dependencies, no browser inside) so the packaged host can drive the Microsoft Edge that
  // Windows already has (see agent/runtime/browser/playwrightEngine.ts launchChromium). Covered by the manifest like every other host file.
  const pwSrc = path.join(ROOT, "node_modules", "playwright-core");
  if (!fs.existsSync(path.join(pwSrc, "package.json"))) fail("playwright-core is missing; run npm install (browser automation cannot be packaged without it)");
  fs.rmSync(path.join(OUT, "node_modules", "playwright-core"), { recursive: true, force: true });
  copyDir(pwSrc, path.join(OUT, "node_modules", "playwright-core"));

  // HUD and frontend.
  fs.mkdirSync(path.dirname(path.join(OUT, HUD_REL)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, HUD_REL), path.join(OUT, HUD_REL));
  // Vision: the offline OCR helper the daemon runs for desktop.read_text (found beside the HUD build).
  const OCR_REL = "src/hud-native/target/release/dask-ocr.exe";
  if (fs.existsSync(path.join(ROOT, OCR_REL))) fs.copyFileSync(path.join(ROOT, OCR_REL), path.join(OUT, OCR_REL)); else log("dask-ocr.exe not built; desktop.read_text is unavailable in this package");
  fs.mkdirSync(path.join(OUT, ".next", "server", "app"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, ".next", "server", "app", "index.html"), path.join(OUT, ".next", "server", "app", "index.html"));
  copyDir(path.join(ROOT, ".next", "static"), path.join(OUT, ".next", "static"));
  copyDir(path.join(ROOT, "public"), path.join(OUT, "public"));

  // Inference runtime and models. The supervisor verifies both against artifacts.json before every launch.
  const runtimeDir = artifacts.runtime.installDir;
  copyDir(path.join(ROOT, runtimeDir), path.join(OUT, runtimeDir));
  for (const id of (argValue("models") ?? artifacts.models.map((m) => m.id).join(",")).split(",")) {
    const m = modelFile(id.trim());
    const modelPath = m.file ?? m.path;
    const source = path.join(ROOT, modelPath);
    if (fs.existsSync(source)) linkOrCopy(source, path.join(OUT, modelPath));
    else log(`model not present, not packaged: ${modelPath}`);
  }
  // Local embedding model for the knowledge index (bge-small-en-v1.5 q8_0, MIT, ~37 MB). The host checks its pinned SHA-256
  // (agent/runtime/knowledge/embedder.ts, itself covered by the manifest) before every start; without it, knowledge search is keyword-only.
  {
    const emb = "models/bge-small-en-v1.5-q8_0.gguf";
    if (fs.existsSync(path.join(ROOT, emb))) { linkOrCopy(path.join(ROOT, emb), path.join(OUT, emb)); log("embedding model packaged"); }
    else log(`embedding model not present, not packaged (knowledge search will be keyword-only): ${emb}`);
  }

  // Plugin sandbox (the host runs plugin code only through these two files): shipped beside the host and hash-covered.
  const sandboxRel = "agent/runtime/plugins";
  fs.mkdirSync(path.join(OUT, sandboxRel), { recursive: true });
  for (const f of ["sandboxRunner.cjs", "sandboxPreload.cjs"]) fs.copyFileSync(path.join(ROOT, sandboxRel, f), path.join(OUT, sandboxRel, f));
  copyDir(path.join(ROOT, "plugins-samples"), path.join(OUT, "plugins-samples"));

  // Optional offline STT (whisper.cpp): the HUD uses it only if every pinned file hashes as in whisper-artifacts.json.
  fs.mkdirSync(path.join(OUT, "agent/runtime/inference"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "agent/runtime/inference/whisper-artifacts.json"), path.join(OUT, "agent/runtime/inference/whisper-artifacts.json"));
  fs.mkdirSync(path.join(OUT, "scripts/inference"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts/inference/fetch-whisper.mjs"), path.join(OUT, "scripts/inference/fetch-whisper.mjs"));
  const whisperArt = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/runtime/inference/whisper-artifacts.json"), "utf8"));
  if (fs.existsSync(path.join(ROOT, whisperArt.runtime.installDir))) {
    copyDir(path.join(ROOT, whisperArt.runtime.installDir), path.join(OUT, whisperArt.runtime.installDir));
    const wm = path.join(whisperArt.model.installDir, whisperArt.model.file);
    if (fs.existsSync(path.join(ROOT, wm))) linkOrCopy(path.join(ROOT, wm), path.join(OUT, wm));
    log("whisper.cpp runtime and model packaged");
  } else log("whisper.cpp not installed; the package uses the Windows recognizer (install later with scripts/inference/fetch-whisper.mjs)");

  // Per-user installer and uninstaller (no administrator rights).
  for (const f of ["Install-D-ASK.ps1", "Uninstall-D-ASK.ps1"]) fs.copyFileSync(path.join(ROOT, "scripts/package", f), path.join(OUT, f));

  // Electron is excluded from the native package: nothing of it may be shipped.
  const electron = walk(OUT).map(rel).filter((r) => /(^|\/)(electron|electron-builder)(\/|\.exe$)|^main\.js$/i.test(r) && !r.startsWith("public/") && !r.startsWith("node_modules/playwright-core/")); // playwright-core ships a JavaScript automation adapter NAMED "electron"; it is not Electron (no runtime, no app)
  if (electron.length) fail(`Electron files in the package: ${electron.slice(0, 5).join(", ")}`);

  // The manifest: the Node runtime and every file the host can load (including the plugin sandbox).
  const covered = [path.join(OUT, NODE_REL), ...walk(path.join(OUT, "dist", "agent-host")), ...walk(path.join(OUT, sandboxRel)), ...walk(path.join(OUT, "node_modules", "better-sqlite3")), ...walk(path.join(OUT, "node_modules", "playwright-core"))];
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: pinned.version,
    nodePath: NODE_REL,
    entryPath: ENTRY_REL,
    files: covered.map((f) => ({ path: rel(f), sha256: sha256(f) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifestPath = path.join(OUT, MANIFEST);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestHash = sha256(manifestPath);

  // Settings for the packaged daemon only. Experimental switches stay off and inference stays local.
  const settingsPath = path.join(OUT, DAEMON_DIR, "appsettings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings.AgentHost = {
    ...settings.AgentHost,
    NodePath: NODE_REL,
    EntryPath: ENTRY_REL,
    RequireVerifiedPackage: true,
    ManifestPath: MANIFEST,
    ManifestSha256: manifestHash,
    ExperimentalCapabilityCheck: false,
    ExperimentalModelTiers: false,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const daemonRel = DAEMON_DIR.replaceAll("/", "\\");
  const hudRel = HUD_REL.replaceAll("/", "\\");
  // Wait (up to 30 s) until the daemon really is listening, instead of a fixed pause: a cold first start can take longer than 3 s, and the HUD would
  // otherwise honestly report "the daemon is not connected" for a first request. If the wait ends without the pipe, the HUD still starts and reconnects.
  const waitForPipe = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"for ($i = 0; $i -lt 60; $i++) { if (Test-Path '\\\\.\\pipe\\d-ask-ipc-v1') { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1\"";
  const launcher = (profile) => [
    "@echo off",
    "rem Starts the daemon, then the HUD. The daemon starts the agent host on the first task.",
    "setlocal",
    "cd /d \"%~dp0\"",
    "if not exist \"%LOCALAPPDATA%\\D-ASK\" mkdir \"%LOCALAPPDATA%\\D-ASK\"",
    "set DASK_HUD_LOG=%LOCALAPPDATA%\\D-ASK\\hud.log",
    ...(profile ? [
      "rem Product profile: every capability is OFFERED to the agent (see features.default.cmd). Approvals, the safety latch and Emergency Stop still apply to every action.",
      "rem Your own %LOCALAPPDATA%\\D-ASK\\features.cmd, if present, replaces the profile. Start-D-ASK-Safe.cmd starts with none of them.",
      "if exist \"%LOCALAPPDATA%\\D-ASK\\features.cmd\" (call \"%LOCALAPPDATA%\\D-ASK\\features.cmd\") else (call \"%~dp0features.default.cmd\")",
    ] : [
      "rem Safe mode: core assistant only (questions, time, system info, arithmetic, read-only files). No feature switches are loaded.",
    ]),
    `start "" /d "%~dp0${daemonRel}" /min "%~dp0${daemonRel}\\DAsk.Daemon.exe"`,
    waitForPipe,
    `start "" /d "%~dp0." "%~dp0${hudRel}"`,
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(OUT, "Start-D-ASK.cmd"), launcher(true));
  fs.writeFileSync(path.join(OUT, "Start-D-ASK-Safe.cmd"), launcher(false));

  // The full product profile. The folder D-ASK may organise and keep notes in is one the user can see: Documents\\D-ASK.
  const profileLines = [
    "rem D-ASK product profile: all ten capabilities are offered. These switches only OFFER tools to the agent.",
    "rem Every protected action (typing, clicking, organising files, browser fill/click, scheduling, plugin permissions) still needs your approval card;",
    "rem the safety latch and Emergency Stop (Ctrl+Shift+F12) apply to all of them. Copy this file to %LOCALAPPDATA%\\D-ASK\\features.cmd to change it.",
    "if not exist \"%USERPROFILE%\\Documents\\D-ASK\" mkdir \"%USERPROFILE%\\Documents\\D-ASK\"",
    "set DASK_AgentHost__Notes=true",
    "set DASK_AgentHost__Workflows=true",
    "set DASK_AgentHost__FileOrganize=true",
    "set DASK_AgentHost__FileOrganizeRoots__0=%USERPROFILE%\\Documents\\D-ASK",
    "set DASK_AgentHost__Plugins=true",
    "set DASK_AgentHost__DesktopOcr=true",
    "set DASK_AgentHost__BrowserRead=true",
    "set DASK_AgentHost__BrowserActions=true",
    "set DASK_AgentHost__Memory=true",
    "set DASK_AgentHost__DesktopMouseInput=true",
    "set DASK_AgentHost__DesktopKeyboardInput=true",
    "set DASK_AgentHost__DesktopAppLaunch=true",
    "rem 2026-11-14: clipboard (each read/write approved) and Windows administration (reads free; every change approved, read back;",
    "rem power actions scheduled and cancellable). Services D-ASK may start/stop: add DASK_AgentHost__SystemAdminServices__0=<name> lines.",
    "set DASK_AgentHost__Clipboard=true",
    "set DASK_AgentHost__SystemAdmin=true",
    "rem Your own Chrome (opt-in; install the D-ASK extension and run scripts\\chrome\\register-native-host.ps1 first):",
    "rem set DASK_AgentHost__ChromeControl=true",
    "rem Approved code edits inside one folder (opt-in):",
    "rem set DASK_AgentHost__DevEditRoots__0=%USERPROFILE%\\source",
    "rem Knowledge (local RAG): folders under Documents may be indexed when you ask (\"index <folder> as <name>\"). Indexing only reads;",
    "rem the index lives in %LOCALAPPDATA%\\D-ASK\\knowledge.db and research reports in Documents\\D-ASK\\Research. Add more folders separated by ;",
    "set DASK_KNOWLEDGE_ROOTS=%USERPROFILE%\\Documents",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(OUT, "features.default.cmd"), profileLines);
  fs.writeFileSync(path.join(OUT, "features.example.cmd"), profileLines.replace("D-ASK product profile: all ten capabilities are offered.", "Example feature switches (this is the same list the product profile uses). Delete the lines you do not want."));

  // The packaged Node must open a database with the shipped better-sqlite3 and have FTS5 (what MemoryStore needs): checked on the real package.
  {
    const probe = path.join(os.tmpdir(), `dask-sqlite-probe-${process.pid}.cjs`);
    fs.writeFileSync(probe, "const D=require(process.argv[2]);const d=new D(':memory:');d.exec('create virtual table t using fts5(a)');d.prepare('insert into t values (?)').run('x');process.stdout.write(String(d.prepare('select count(*) c from t where t match ?').get('x').c));");
    const r = spawnSync(path.join(OUT, NODE_REL), [probe, path.join(OUT, "node_modules", "better-sqlite3")], { encoding: "utf8" });
    fs.rmSync(probe, { force: true });
    if (r.status !== 0 || r.stdout.trim() !== "1") fail(`the packaged Node cannot use the shipped better-sqlite3 (FTS5 query): ${(r.stderr || r.stdout).slice(0, 300)}`);
    log("packaged Node opened a SQLite database with the shipped better-sqlite3 (FTS5 ok)");
  }

  log(`package written to ${OUT}`);
  log(`manifest SHA-256 ${manifestHash} (${manifest.files.length} files)`);
  verifyManifest();
}

if (VERIFY_ONLY) verifyManifest();
else await build();
