#!/usr/bin/env node
// Explicit, one-time download of the pinned whisper.cpp CPU build and the pinned English model (optional offline STT).
//
//   node scripts/inference/fetch-whisper.mjs            download + verify + install (runtime and model)
//   node scripts/inference/fetch-whisper.mjs --verify   verify an existing install only
//   node scripts/inference/fetch-whisper.mjs --from D   install from files already downloaded into D (still hash-verified)
//   (Fallback when Node's fetch stalls: curl.exe -L --ssl-no-revoke -o D\<name> <source URL>; integrity comes from the pins.)
//
// The archive must match runtime.archiveSha256 and the model must match model.sha256 in
// agent/runtime/inference/whisper-artifacts.json, or nothing is installed. After a verified install the
// extracted files' SHA-256 are written into runtime.files; the HUD re-checks every pinned file before use.
// Nothing in D-ASK runs this automatically.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(ROOT, "agent/runtime/inference/whisper-artifacts.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const rt = manifest.runtime;
const model = manifest.model;
const installDir = path.join(ROOT, rt.installDir);
const modelPath = path.join(ROOT, model.installDir, model.file);

const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
});

function verifyInstall() {
  let ok = true;
  const pinned = Object.entries(rt.files ?? {});
  if (pinned.length === 0) { console.error("No pinned runtime.files yet."); ok = false; }
  for (const [rel, want] of pinned) {
    const p = path.join(installDir, rel);
    const got = fs.existsSync(p) ? sha256File(p) : "(missing)";
    if (got !== want) { ok = false; console.error(`MISMATCH ${rel}`); }
  }
  const m = fs.existsSync(modelPath) ? sha256File(modelPath) : "(missing)";
  if (m !== model.sha256) { ok = false; console.error(`MODEL MISMATCH ${model.file}: ${m}`); }
  console.log(ok ? `Install verified: ${pinned.length} runtime files + model match the manifest.` : "Install verification FAILED.");
  return ok;
}

// --from <dir>: use files already downloaded into <dir> (same names as the source URLs). They are hash-verified exactly
// like a download; nothing unverified is installed.
const fromIdx = process.argv.indexOf("--from");
const fromDir = fromIdx > 0 ? path.resolve(process.argv[fromIdx + 1] ?? "") : null;

async function download(url, dest, allowedHosts) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !allowedHosts.includes(u.hostname)) throw new Error(`Unexpected source: ${url}`);
  if (fromDir) {
    const local = path.join(fromDir, path.posix.basename(u.pathname));
    console.log(`Using local copy ${local}`);
    fs.copyFileSync(local, dest);
    return;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function installRuntime() {
  if (fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0) { console.log(`Runtime already present: ${installDir} (not overwritten)`); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dask-whisper-dl-"));
  try {
    const archive = path.join(work, "whisper-bin-x64.zip");
    await download(rt.source, archive, ["github.com"]);
    const got = sha256File(archive);
    if (got !== rt.archiveSha256) throw new Error(`HASH MISMATCH for the archive (${got}). Nothing installed.`);
    console.log("Archive hash matches the pinned published digest.");
    const staging = path.join(work, "extract");
    fs.mkdirSync(staging);
    const tarExe = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    if (spawnSync(tarExe, ["-xf", archive, "-C", staging], { stdio: "inherit" }).status !== 0) throw new Error("Extraction failed");
    // The executable may sit in a sub-folder (e.g. Release/); install that folder's contents.
    const exe = listFiles(staging).find((f) => path.posix.basename(f) === rt.executable);
    if (!exe) throw new Error(`${rt.executable} not found in archive`);
    const src = path.join(staging, path.posix.dirname(exe));
    fs.mkdirSync(installDir, { recursive: true });
    fs.cpSync(src, installDir, { recursive: true });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  rt.files = Object.fromEntries(listFiles(installDir).sort().map((rel) => [rel, sha256File(path.join(installDir, rel))]));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Installed ${Object.keys(rt.files).length} files to ${installDir}; pinned in runtime.files.`);
}

async function installModel() {
  if (fs.existsSync(modelPath) && sha256File(modelPath) === model.sha256) { console.log(`Model already present and verified: ${modelPath}`); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dask-whisper-model-"));
  try {
    const tmp = path.join(work, model.file);
    await download(model.source, tmp, ["huggingface.co"]);
    const got = sha256File(tmp);
    if (got !== model.sha256) throw new Error(`HASH MISMATCH for the model (${got}). Nothing installed.`);
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.copyFileSync(tmp, modelPath);
    console.log(`Model verified and installed: ${modelPath}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.includes("--verify")) process.exit(verifyInstall() ? 0 : 1);
  await installRuntime();
  await installModel();
  process.exit(verifyInstall() ? 0 : 1);
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
