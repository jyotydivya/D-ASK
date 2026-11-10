// Pinned artifact manifest + SHA-256 verification. Nothing here downloads anything.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import manifestJson from "./artifacts.json";

export interface RuntimeArtifact {
  id: string;
  version: string;
  commit: string;
  os: string;
  arch: string;
  variant: string;
  source: string;
  archiveSha256: string;
  installDir: string;
  executable: string;
  /** Relative path → SHA-256 of every installed file. */
  files: Record<string, string>;
}

export interface ModelArchitecture {
  nLayer: number;
  nKvHead: number;
  headDim: number;
  nVocab: number;
}

export interface ModelArtifact {
  id: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  architecture: ModelArchitecture;
  defaultContext: number;
}

export interface ArtifactManifest {
  schemaVersion: number;
  runtime: RuntimeArtifact;
  models: ModelArtifact[];
}

export const PINNED_MANIFEST = manifestJson as unknown as ArtifactManifest;

export function findModel(manifest: ArtifactManifest, id: string): ModelArtifact {
  const m = manifest.models.find((x) => x.id === id);
  if (!m) throw new Error(`Model "${id}" is not in the pinned manifest`);
  return m;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface VerificationResult {
  ok: boolean;
  errors: string[];
}

export async function verifyRuntime(root: string, rt: RuntimeArtifact): Promise<VerificationResult> {
  const dir = path.resolve(root, rt.installDir);
  const entries = Object.entries(rt.files);
  const errors: string[] = [];
  if (entries.length === 0) errors.push("manifest pins no runtime files");
  if (!rt.files[rt.executable]) errors.push(`manifest does not pin the executable ${rt.executable}`);
  for (const [rel, want] of entries) {
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) { errors.push(`${rel}: path escapes the install directory`); continue; }
    if (!fs.existsSync(file)) { errors.push(`${rel}: missing`); continue; }
    const got = await sha256File(file);
    if (got !== want) errors.push(`${rel}: SHA-256 mismatch`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Model hashes are expensive (seconds for multi-GB files), so a verified hash is
 * cached for this process, keyed by path + size + mtime. Any change re-hashes.
 */
const modelHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

export async function verifyModel(root: string, model: ModelArtifact): Promise<VerificationResult> {
  const file = path.resolve(root, model.file);
  if (!fs.existsSync(file)) return { ok: false, errors: [`model file missing: ${model.file}`] };
  const st = fs.statSync(file);
  if (st.size !== model.sizeBytes) return { ok: false, errors: [`model size ${st.size} != pinned ${model.sizeBytes}`] };
  const cached = modelHashCache.get(file);
  let sha = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs ? cached.sha256 : null;
  if (!sha) {
    sha = await sha256File(file);
    modelHashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256: sha });
  }
  return sha === model.sha256 ? { ok: true, errors: [] } : { ok: false, errors: [`model SHA-256 mismatch for ${model.file}`] };
}
