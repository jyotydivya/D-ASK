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
  const electron = walk(OUT).map(rel).filter((r) => /(^|\/)(electron|electron-builder)(\/|\.exe$)|^main\.js$/i.test(r) && !r.startsWith("public/"));
  if (electron.length) fail(`Electron files in the package: ${electron.slice(0, 5).join(", ")}`);

  // The manifest: the Node runtime and every file the host can load (including the plugin sandbox).
  const covered = [path.join(OUT, NODE_REL), ...walk(path.join(OUT, "dist", "agent-host")), ...walk(path.join(OUT, sandboxRel))];
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

  fs.writeFileSync(path.join(OUT, "Start-D-ASK.cmd"), [
    "@echo off",
    "rem Starts the daemon, then the HUD. The daemon starts the agent host on the first task.",
    "setlocal",
    "cd /d \"%~dp0\"",
    "if not exist \"%LOCALAPPDATA%\\D-ASK\" mkdir \"%LOCALAPPDATA%\\D-ASK\"",
    "set DASK_HUD_LOG=%LOCALAPPDATA%\\D-ASK\\hud.log",
    `start "" /d "%~dp0${DAEMON_DIR.replaceAll("/", "\\")}" /min "%~dp0${DAEMON_DIR.replaceAll("/", "\\")}\\DAsk.Daemon.exe"`,
    "timeout /t 3 /nobreak >nul",
    `start "" /d "%~dp0." "%~dp0${HUD_REL.replaceAll("/", "\\")}"`,
    "",
  ].join("\r\n"));

  log(`package written to ${OUT}`);
  log(`manifest SHA-256 ${manifestHash} (${manifest.files.length} files)`);
  verifyManifest();
}

if (VERIFY_ONLY) verifyManifest();
else await build();
