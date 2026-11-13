// HUD management helpers (workflows, plugins, memory, knowledge collections, research projects). Pure functions, no React, no network.
//
// The management panel has NO private channel to the daemon. Every button builds an ordinary natural-language request that is submitted through the
// same path as typed text (same runtime, same grounding, same approval cards, same Emergency Stop). The panel shows what the list requests returned;
// it never invents state. These functions read the list replies and build the request text, nothing else.

export interface WorkflowRow { name: string; steps: number; schedule: string | null; last: string | null }
export interface PluginRow {
  id: string; version: string | null; installed: boolean; enabled: boolean; changed: boolean;
  permissions: { name: string; granted: boolean }[]; tools: string[]; note: string | null;
}
export interface MemoryRow { id: string; text: string; kind: string }

/** One trimmed, non-empty line each, with any leading bullets removed (the tool's own and the reply composer's: "• • x"). */
const lines = (response: string) => response.split(/\r?\n/).map((l) => l.trim().replace(/^(?:•\s*)+/, "")).filter(Boolean);
const uniqueBy = <T,>(rows: T[], key: (r: T) => string): T[] => { const seen = new Set<string>(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** "nightly: 2 step(s), runs every day at 09:00 (last: submitted as task t1)" */
export function parseWorkflows(response: string): WorkflowRow[] | null {
  if (/No workflows are saved/i.test(response)) return [];
  const rows: WorkflowRow[] = [];
  for (const l of lines(response)) {
    const m = /^(.+?): (\d+) step\(s\)(?:, runs (.+?))?(?: \(last: (.+)\))?$/.exec(l);
    if (m) rows.push({ name: m[1]!, steps: Number(m[2]), schedule: m[3] ?? null, last: m[4] ?? null });
  }
  return rows.length ? uniqueBy(rows, (r) => r.name) : null;
}

/** "• note_reader 1.0.0 — installed, enabled — permissions: compute=granted, files.read=not granted — tools: file_head, my_notes" */
export function parsePlugins(response: string): PluginRow[] | null {
  if (/No plugins in the plugins folder/i.test(response)) return [];
  const rows: PluginRow[] = [];
  for (const l of lines(response)) {
    const parts = l.split(" — ");
    if (parts.length < 2) continue;
    const head = /^([a-z][a-z0-9_]{1,30})(?: (\d+\.\d+\.\d+))?$/.exec(parts[0] ?? "");
    if (!head) continue;
    const status = parts[1] ?? "";
    const row: PluginRow = {
      id: head[1]!, version: head[2] ?? null, installed: /^installed/.test(status), enabled: /installed, enabled/.test(status),
      changed: /changed since approval/.test(status), permissions: [], tools: [], note: null,
    };
    for (const p of parts.slice(2)) {
      const pm = /^permissions: (.+)$/.exec(p);
      if (pm) for (const item of pm[1]!.split(", ")) { const kv = /^([a-z.]+)=(granted|not granted)$/.exec(item.trim()); if (kv) row.permissions.push({ name: kv[1]!, granted: kv[2] === "granted" }); }
      const tm = /^tools: (.+?)(?: \((.+)\))?$/.exec(p);
      if (tm) { row.tools = tm[1]!.split(", "); row.note = tm[2] ?? null; }
    }
    rows.push(row);
  }
  return rows.length ? uniqueBy(rows, (r) => r.id) : null;
}

/** "• [3fa4b2c1] my favourite editor is Neovim (preference)" */
export function parseMemories(response: string): MemoryRow[] | null {
  if (/I have no saved memories/i.test(response)) return [];
  const rows: MemoryRow[] = [];
  for (const l of lines(response)) {
    const m = /^\[([0-9a-f]{8})\]\s+(.+?)\s+\(([a-z]+)(?:, [a-z]+)?\)$/.exec(l);
    if (m) rows.push({ id: m[1]!, text: m[2]!, kind: m[3]! });
  }
  return rows.length ? uniqueBy(rows, (r) => r.id) : null;
}

export interface CollectionRow { name: string; kind: string; documents: number; passages: number; embedded: string; unreadable: number; last: string; note: string | null; folders: string[] }
export interface ResearchRow { id: string; topic: string; type: string; versions: number; last: string; sources: number }

/** "• research [research] — 3 document(s), 216 passage(s), all with embeddings, 1 unreadable; last indexed 2026-11-12 17:50 (last run cancelled)" + "folders: a; b" */
export function parseCollections(response: string): CollectionRow[] | null {
  if (/No knowledge collections yet/i.test(response)) return [];
  const rows: CollectionRow[] = [];
  for (const l of lines(response)) {
    const m = /^(\S+) \[(personal|research|code|folder)\] — (\d+) document\(s\), (\d+) passage\(s\), (all|\d+\/\d+) with embeddings(?:, (\d+) unreadable)?; last indexed (.+?)(?: \(last run (\w+)\))?$/.exec(l);
    if (m) { rows.push({ name: m[1]!, kind: m[2]!, documents: Number(m[3]), passages: Number(m[4]), embedded: m[5]!, unreadable: Number(m[6] ?? 0), last: m[7]!, note: m[8] ? `last run ${m[8]}` : null, folders: [] }); continue; }
    const f = /^folders: (.*)$/.exec(l);
    if (f && rows.length) rows[rows.length - 1]!.folders = f[1]!.split("; ").filter(Boolean);
  }
  return rows.length ? uniqueBy(rows, (r) => r.name) : null;
}

/** "• graph neural networks — Literature review, 2 version(s), last 2026-11-12 17:56, 3 source(s) [id graph-neural-networks-20261112e6f5]" */
export function parseResearch(response: string): ResearchRow[] | null {
  if (/No research projects yet/i.test(response)) return [];
  const rows: ResearchRow[] = [];
  for (const l of lines(response)) {
    const m = /^(.+?) — (.+?), (\d+) version\(s\), last (.+?), (\d+) source\(s\) \[id ([a-z0-9-]+)\]$/.exec(l);
    if (m) rows.push({ topic: m[1]!, type: m[2]!, versions: Number(m[3]), last: m[4]!, sources: Number(m[5]), id: m[6]! });
  }
  return rows.length ? uniqueBy(rows, (r) => r.id) : null;
}

export const REPORT_KINDS = { "literature review": "Prepare a literature review about", "methodology comparison": "Compare the methodologies of research about", "gap analysis": "Write a gap analysis on", "technical summary": "Write a technical summary on" } as const;
export const RESEARCH_SCOPES = { "my research papers": "from my research papers", "all my documents": "from my documents", "the codebase": "from the codebase" } as const;

/** A collection name the knowledge grammar accepts: letters, digits, "-", "_" and "."; spaces become "-". Null when nothing usable remains. */
export function collectionName(raw: string): string | null {
  const n = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, 38);
  return /^[a-z0-9]/.test(n) ? n : null;
}

// ── requests (exactly the grammar the agent accepts) ─────────────────────────
/** A name with spaces or punctuation is quoted, as the workflow grammar requires. */
const q = (name: string) => (/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(name) ? name : `"${name.replace(/"/g, "")}"`);

export const REQ = {
  listWorkflows: () => "List my workflows.",
  listPlugins: () => "List my plugins.",
  listMemories: () => "List my saved memories.",
  runWorkflow: (name: string) => `Run the workflow ${q(name)}`,
  deleteWorkflow: (name: string) => `Delete the workflow ${q(name)}`,
  unscheduleWorkflow: (name: string) => `Unschedule the workflow ${q(name)}`,
  scheduleWorkflow: (name: string, when: string) => `Schedule the workflow ${q(name)} ${when}`,
  installPlugin: (id: string) => `Install the plugin ${id}`,
  removePlugin: (id: string) => `Remove the plugin ${id}`,
  enablePlugin: (id: string) => `Enable the plugin ${id}`,
  disablePlugin: (id: string) => `Disable the plugin ${id}`,
  grantPermission: (id: string, perm: string) => `Grant the plugin ${id} the ${perm} permission`,
  revokePermission: (id: string, perm: string) => `Revoke the ${perm} permission of the plugin ${id}`,
  forgetMemory: (id: string) => `Forget memory ${id}`,
  listCollections: () => "List my knowledge collections.",
  indexFolder: (folder: string, name: string) => `Index "${folder.replace(/"/g, "")}" as ${name}`,
  indexCodebase: () => "Index the codebase",
  refreshCollection: (name: string) => `Refresh the collection ${name}`,
  removeCollection: (name: string) => `Remove the collection ${name}`,
  listResearch: () => "List research projects.",
  resumeResearch: (id: string) => `Resume research ${id}`,
  showResearch: (id: string) => `Show research report ${id}`,
  startResearch: (kind: keyof typeof REPORT_KINDS, topic: string, scope: keyof typeof RESEARCH_SCOPES) =>
    `${REPORT_KINDS[kind]} ${topic.replace(/\s+/g, " ").replace(/[.?!]+$/, "").trim()} ${RESEARCH_SCOPES[scope]}`,
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** The timing phrase of a schedule request, from the panel's two inputs (a daily or weekly time). Null when the time is not HH:MM. */
export function scheduleWhen(kind: "daily" | (typeof WEEKDAYS)[number], hhmm: string): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  return kind === "daily" ? `every day at ${hhmm}` : `every ${kind} at ${hhmm}`;
}
