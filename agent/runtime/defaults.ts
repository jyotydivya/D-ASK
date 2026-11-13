// Default tool registry and permission grants. Dependency-light so that both the
// Next.js bridge (index.ts) and the stdio agent host can use it; it must not import
// the task/event services or any cloud module.

import { ToolRegistry } from "./toolRegistry";
import { createWorkspaceListDirTool, mathEvaluateTool, systemInfoTool, systemTimeTool } from "./tools/builtin";
import { createFilesystemTools, type FileAccessConfig } from "./tools/filesystem";
import { createDesktopTools, type DesktopBridge } from "./tools/desktop";
import { createWorkflowTools } from "./tools/workflows";
import { createPluginTools } from "./tools/pluginTools";
import { createNoteTools } from "./tools/notes";
import type { ToolPermission } from "./types";

/** What the default runtime may do. Nothing that writes, spawns, actuates, or uses the network. */
export const DEFAULT_GRANTS: ReadonlySet<ToolPermission> = new Set<ToolPermission>([
  "read:clock",
  "read:system",
  "read:workspace",
  "compute",
]);

export interface DefaultRegistryOptions {
  /** Folders beyond the workspace the user approved for reading (DASK_FS_ROOTS). Never widened beyond these. */
  fileRoots?: readonly string[];
  /** Told once which configured roots were refused (not absolute, missing, a drive, the OS, the whole profile). */
  onRootsRejected?: FileAccessConfig["onRootsRejected"];
  /** Phase 7B.1b: read-only desktop observation through the daemon. Absent: the desktop tools do not exist. */
  desktop?: DesktopBridge;
  // Browser and memory tools are host-only: see hostRegistry.ts (kept out of the Next.js bundle).
}

export function createDefaultRegistry(
  workspaceRoot: string = process.env.DASK_WORKSPACE_ROOT || process.cwd(),
  options: DefaultRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry()
    .register(systemTimeTool)
    .register(systemInfoTool)
    .register(mathEvaluateTool)
    .register(createWorkspaceListDirTool(workspaceRoot));
  // Phase 7A: read-only filesystem tools over the workspace and approved folders.
  for (const tool of createFilesystemTools({ workspaceRoot, extraRoots: options.fileRoots ?? [], onRootsRejected: options.onRootsRejected }, options.desktop)) {
    registry.register(tool);
  }
  if (options.desktop) for (const tool of createDesktopTools(options.desktop)) registry.register(tool);
  // Workflows: daemon-owned store; the tools exist only with the bridge (and act only if the daemon offers them).
  if (options.desktop) for (const tool of createWorkflowTools(options.desktop)) registry.register(tool);
  // Plugin management requests (the daemon approves; the host runs approved plugins in its sandbox).
  if (options.desktop) for (const tool of createPluginTools(options.desktop)) registry.register(tool);
  // Notes: the daemon writes ONE new note in its notes folder after approval; the tool exists only with the bridge.
  if (options.desktop) for (const tool of createNoteTools(options.desktop)) registry.register(tool);
  return registry;
}
