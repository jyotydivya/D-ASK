// Host-side capabilities a plugin can use only when the user has granted the matching permission (the permission check itself is in
// PluginManager.serveCapability; this file is what happens AFTER it passes). Each capability is still bounded:
//   files.read   reads ONE text file inside the folders D-ASK may read, through the same path rules as the built-in file tools
//                (no links out of a root, no secret or hidden names, text only, size-limited, secret-looking values redacted).
//   memory.read  searches the notes the user asked D-ASK to remember (source "user" only); it cannot add, change or delete them.

import { promises as fs } from "node:fs";
import type { MemoryStore } from "../memory/memoryStore";
import { DEFAULT_FILE_LIMITS, decodeText, isSecretName, redactSecrets, resolveInside, resolveRoots, type FileRoot } from "../tools/fileAccess";
import type { PluginCapabilities } from "./pluginManager";

export const PLUGIN_MAX_FILE_BYTES = 256 * 1024;
export const PLUGIN_MAX_TEXT_CHARS = 20_000;

export function createPluginCapabilities(opts: { workspaceRoot: string; extraRoots?: readonly string[]; memory?: MemoryStore }): PluginCapabilities {
  let roots: Promise<FileRoot[]> | null = null;
  const getRoots = () => (roots ??= resolveRoots(opts.workspaceRoot, opts.extraRoots ?? []).then((r) => r.roots));
  return {
    async readFile(requested, signal) {
      const rs = await getRoots();
      if (!rs.length) return { ok: false, reason: "no readable folders are configured" };
      const r = await resolveInside(rs, requested);
      if (!r.ok) return { ok: false, reason: r.error };
      if (!r.stats.isFile()) return { ok: false, reason: "that is a folder, not a file" };
      const name = r.canonical.split(/[\\/]/).pop() ?? "";
      if (isSecretName(name)) return { ok: false, reason: "that file looks like it holds secrets, so it is never read" };
      if (r.stats.size > Math.min(PLUGIN_MAX_FILE_BYTES, DEFAULT_FILE_LIMITS.maxReadFileBytes)) return { ok: false, reason: `the file is larger than ${PLUGIN_MAX_FILE_BYTES / 1024} KB` };
      const buf = await fs.readFile(r.canonical, { signal });
      const d = decodeText(buf);
      if (!d.ok) return { ok: false, reason: d.reason };
      const text = redactSecrets(d.text).text.slice(0, PLUGIN_MAX_TEXT_CHARS);
      return { ok: true, text };
    },
    async searchMemory(query) {
      if (!opts.memory) return [];
      return opts.memory.recall(query, { limit: 5, touch: false }).filter((h) => h.source === "user").map((h) => String(h.content).slice(0, 200));
    },
  };
}
