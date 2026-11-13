#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Explicit, one-time download of ONE pinned model from agent/runtime/inference/artifacts.json.
//
//   node scripts/inference/fetch-model.mjs <model-id>
//
// - Only models with a pinned `source` (revision-locked URL) and `sha256` can be fetched.
// - Never overwrites or replaces an existing file (existing models are preserved).
// - Downloads to a temporary file in its own new directory, verifies size and
//   SHA-256, and only then moves it into place. A mismatch installs nothing.
// Nothing in D-ASK runs this automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/runtime/inference/artifacts.json"), "utf8"));
const id = process.argv[2];
const model = manifest.models.find((m) => m.id === id);
if (!model) { console.error(`Unknown model id "${id}". Known: ${manifest.models.map((m) => m.id).join(", ")}`); process.exit(1); }
if (!model.source) { console.error(`Model "${id}" has no pinned source; it is not downloadable.`); process.exit(1); }

const dest = path.join(ROOT, model.file);
if (fs.existsSync(dest)) { console.error(`Refusing to overwrite existing file ${dest}`); process.exit(1); }
const url = new URL(model.source);
if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || !/\/resolve\/[0-9a-f]{40}\//.test(url.pathname)) {
  console.error(`Source must be a revision-pinned https://huggingface.co/.../resolve/<sha>/... URL`); process.exit(1);
}

const work = fs.mkdtempSync(path.join(path.dirname(dest), ".dl-"));
const tmp = path.join(work, path.basename(dest));
try {
  console.log(`Downloading ${model.source}`);
  const res = await fetch(model.source, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0; let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    hash.update(chunk); bytes += chunk.length;
    const pct = Math.floor((bytes / model.sizeBytes) * 10) * 10;
    if (pct !== lastPct) { lastPct = pct; console.log(`  ${pct}% (${Math.round(bytes / 1048576)} MiB)`); }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  const sha = hash.digest("hex");
  console.log(`size ${bytes}, sha256 ${sha}`);
  if (bytes !== model.sizeBytes || sha !== model.sha256) throw new Error(`MISMATCH: expected size ${model.sizeBytes} sha256 ${model.sha256}. Nothing installed.`);
  fs.renameSync(tmp, dest);
  console.log(`Verified and installed ${dest}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
