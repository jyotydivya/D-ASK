#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Explicit, one-time download of the pinned llama-server build.
//
//   node scripts/inference/fetch-llama-server.mjs            download + verify + install
//   node scripts/inference/fetch-llama-server.mjs --verify   verify an existing install only
//
// The archive must match runtime.archiveSha256 in agent/runtime/inference/artifacts.json
// (GitHub's published asset digest) or nothing is installed. After a verified
// install it prints the SHA-256 of every extracted file; those are pinned in the
// manifest's runtime.files and checked by the supervisor before every launch.
// This script never downloads models. Nothing in D-ASK runs it automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/runtime/inference/artifacts.json"), "utf8"));
const rt = manifest.runtime;
const installDir = path.join(ROOT, rt.installDir);

const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

function verifyInstall() {
  const pinned = Object.entries(rt.files ?? {});
  if (pinned.length === 0) { console.error("Manifest has no pinned runtime.files yet."); return false; }
  let ok = true;
  for (const [rel, want] of pinned) {
    const p = path.join(installDir, rel);
    const got = fs.existsSync(p) ? sha256File(p) : "(missing)";
    if (got !== want) { ok = false; console.error(`MISMATCH ${rel}: expected ${want}, got ${got}`); }
  }
  console.log(ok ? `Install verified: ${pinned.length} files match the manifest.` : "Install verification FAILED.");
  return ok;
}

async function main() {
  if (process.argv.includes("--verify")) process.exit(verifyInstall() ? 0 : 1);

  if (fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0) {
    console.error(`Refusing to overwrite a non-empty install directory: ${installDir}\nRun with --verify to check it.`);
    process.exit(1);
  }

  const url = new URL(rt.source);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error(`Unexpected source: ${rt.source}`);

  // Downloaded archive goes in its own new, empty directory.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dask-llama-dl-"));
  const archive = path.join(work, path.basename(url.pathname));
  console.log(`Downloading ${rt.source}`);
  const res = await fetch(rt.source, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

  const got = sha256File(archive);
  console.log(`archive sha256 ${got}`);
  if (got !== rt.archiveSha256) {
    fs.rmSync(work, { recursive: true, force: true });
    console.error(`HASH MISMATCH: expected ${rt.archiveSha256}. Nothing installed.`);
    process.exit(2);
  }
  console.log("Archive hash matches the pinned published digest.");

  try {
    const staging = path.join(work, "extract");
    fs.mkdirSync(staging);
    // Windows' own bsdtar (GNU tar from Git Bash treats "C:" as a remote host).
    const tarExe = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const tar = spawnSync(tarExe, ["-xf", archive, "-C", staging], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error("Extraction failed");

    // The archive may contain a single top-level folder; install its contents.
    const top = fs.readdirSync(staging);
    const src = top.length === 1 && fs.statSync(path.join(staging, top[0])).isDirectory() ? path.join(staging, top[0]) : staging;
    if (!fs.existsSync(path.join(src, rt.executable))) throw new Error(`${rt.executable} not found in archive`);

    fs.mkdirSync(installDir, { recursive: true });
    fs.cpSync(src, installDir, { recursive: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const files = Object.fromEntries(listFiles(installDir).sort().map((rel) => [rel, sha256File(path.join(installDir, rel))]));
  console.log(`Installed ${Object.keys(files).length} files to ${installDir}`);
  console.log("Pin these in runtime.files:");
  console.log(JSON.stringify(files, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
