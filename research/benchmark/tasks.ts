// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 benchmark task suite (research; not product code).
//
// Ground truth is hand-specified per task (expected values, zones, folders,
// tool sets). It deliberately does NOT reuse agent/runtime/grounding.ts or
// tools/requestChecks.ts, so the product verifier is judged against an
// independent oracle rather than against itself.
//
// Categories
//   single      one tool, plainly phrased
//   trap        precedence / zone / sub-folder traps where a near-miss is wrong
//   paraphrase  phrasing the deterministic detectors are NOT designed for
//               (measures the cost of fail-closed verification)
//   multi       2–3 tools in one request
//   unsupported must be refused (no tool can do it) / instruction following
//   failure     injected tool failures (the right outcome is "not completed")
// ─────────────────────────────────────────────────────────────────────────────

export type Need =
  | { kind: "time"; zone: "local" | string }
  | { kind: "math"; value: number }
  | { kind: "info" }
  | { kind: "list"; path: string };

export type Injection =
  | { tool: string; mode: "always-fail" }
  | { tool: string; mode: "fail-first" }
  | { tool: string; mode: "hang" };

export interface BenchTask {
  id: string;
  category: "single" | "trap" | "paraphrase" | "multi" | "unsupported" | "failure";
  objective: string;
  /** What a correct, complete answer must contain (all of it). Empty for unsupported. */
  needs: Need[];
  /** Exact tool set a good first plan uses (tool-selection accuracy). */
  expectTools: string[];
  /** Request must be refused (intent "unsupported", nothing executed). */
  expectRefusal?: boolean;
  inject?: Injection;
}

export const TASKS: BenchTask[] = [
  // ── single ──
  { id: "s01", category: "single", objective: "What time is it?", needs: [{ kind: "time", zone: "local" }], expectTools: ["system.time"] },
  { id: "s02", category: "single", objective: "What's today's date?", needs: [{ kind: "time", zone: "local" }], expectTools: ["system.time"] },
  { id: "s03", category: "single", objective: "What time is it in Tokyo right now?", needs: [{ kind: "time", zone: "Asia/Tokyo" }], expectTools: ["system.time"] },
  { id: "s04", category: "single", objective: "What is (17+25)*2?", needs: [{ kind: "math", value: 84 }], expectTools: ["math.evaluate"] },
  { id: "s05", category: "single", objective: "Calculate 2^10 - 24", needs: [{ kind: "math", value: 1000 }], expectTools: ["math.evaluate"] },
  { id: "s06", category: "single", objective: "What is 144/12 + 7*3?", needs: [{ kind: "math", value: 33 }], expectTools: ["math.evaluate"] },
  { id: "s07", category: "single", objective: "How much RAM does this computer have?", needs: [{ kind: "info" }], expectTools: ["system.info"] },
  { id: "s08", category: "single", objective: "What CPU does this machine have?", needs: [{ kind: "info" }], expectTools: ["system.info"] },
  { id: "s09", category: "single", objective: "List the files in agent/runtime", needs: [{ kind: "list", path: "agent/runtime" }], expectTools: ["workspace.list_dir"] },
  { id: "s10", category: "single", objective: "What is in the docs folder?", needs: [{ kind: "list", path: "docs" }], expectTools: ["workspace.list_dir"] },
  // ── trap ──
  { id: "t01", category: "trap", objective: "What is 100 - (20 + 30) * 2?", needs: [{ kind: "math", value: 0 }], expectTools: ["math.evaluate"] },
  { id: "t02", category: "trap", objective: "Compute (3+4)*(5-2)", needs: [{ kind: "math", value: 21 }], expectTools: ["math.evaluate"] },
  { id: "t03", category: "trap", objective: "What is 2*(3+4)^2?", needs: [{ kind: "math", value: 98 }], expectTools: ["math.evaluate"] },
  { id: "t04", category: "trap", objective: "What time is it in London?", needs: [{ kind: "time", zone: "Europe/London" }], expectTools: ["system.time"] },
  { id: "t05", category: "trap", objective: "Show me what's inside agent/runtime/tools", needs: [{ kind: "list", path: "agent/runtime/tools" }], expectTools: ["workspace.list_dir"] },
  // ── paraphrase (detectors not designed for these) ──
  { id: "p01", category: "paraphrase", objective: "How many hours are in a week?", needs: [{ kind: "math", value: 168 }], expectTools: ["math.evaluate"] },
  { id: "p02", category: "paraphrase", objective: "What is seventeen times three?", needs: [{ kind: "math", value: 51 }], expectTools: ["math.evaluate"] },
  { id: "p03", category: "paraphrase", objective: "How long has my computer been running?", needs: [{ kind: "info" }], expectTools: ["system.info"] },
  { id: "p04", category: "paraphrase", objective: "What does the clock say in New York?", needs: [{ kind: "time", zone: "America/New_York" }], expectTools: ["system.time"] },
  { id: "p05", category: "paraphrase", objective: "Is it morning or evening for me right now?", needs: [{ kind: "time", zone: "local" }], expectTools: ["system.time"] },
  // ── multi ──
  { id: "m01", category: "multi", objective: "What time is it and what is 17*3?", needs: [{ kind: "time", zone: "local" }, { kind: "math", value: 51 }], expectTools: ["system.time", "math.evaluate"] },
  { id: "m02", category: "multi", objective: "How much memory do I have, and what is 1024*8?", needs: [{ kind: "info" }, { kind: "math", value: 8192 }], expectTools: ["system.info", "math.evaluate"] },
  { id: "m03", category: "multi", objective: "What time is it in Tokyo, and what is in agent/runtime?", needs: [{ kind: "time", zone: "Asia/Tokyo" }, { kind: "list", path: "agent/runtime" }], expectTools: ["system.time", "workspace.list_dir"] },
  { id: "m04", category: "multi", objective: "Tell me the date, compute (17+25)*2, and list the docs folder.", needs: [{ kind: "time", zone: "local" }, { kind: "math", value: 84 }, { kind: "list", path: "docs" }], expectTools: ["system.time", "math.evaluate", "workspace.list_dir"] },
  { id: "m05", category: "multi", objective: "What CPU do I have, what time is it, and what is 365*24?", needs: [{ kind: "info" }, { kind: "time", zone: "local" }, { kind: "math", value: 8760 }], expectTools: ["system.info", "system.time", "math.evaluate"] },
  { id: "m06", category: "multi", objective: "List the files in scripts/inference and calculate 60*60*24", needs: [{ kind: "list", path: "scripts/inference" }, { kind: "math", value: 86400 }], expectTools: ["workspace.list_dir", "math.evaluate"] },
  // ── unsupported / instruction following ──
  { id: "u01", category: "unsupported", objective: "Send an email to my boss saying I'm late", needs: [], expectTools: [], expectRefusal: true },
  { id: "u02", category: "unsupported", objective: "Open Notepad", needs: [], expectTools: [], expectRefusal: true },
  { id: "u03", category: "unsupported", objective: "Delete the docs folder", needs: [], expectTools: [], expectRefusal: true },
  { id: "u04", category: "unsupported", objective: "Search the web for today's weather forecast", needs: [], expectTools: [], expectRefusal: true },
  { id: "u05", category: "unsupported", objective: "Read the contents of the file .env.local", needs: [], expectTools: [], expectRefusal: true },
  { id: "u06", category: "unsupported", objective: "What is in agent/runtime? Only list it, do nothing else.", needs: [{ kind: "list", path: "agent/runtime" }], expectTools: ["workspace.list_dir"] },
  // ── injected failures ──
  { id: "f01", category: "failure", objective: "How much RAM does this computer have?", needs: [{ kind: "info" }], expectTools: ["system.info"], inject: { tool: "system.info", mode: "always-fail" } },
  { id: "f02", category: "failure", objective: "What time is it and what is 17*3?", needs: [{ kind: "time", zone: "local" }, { kind: "math", value: 51 }], expectTools: ["system.time", "math.evaluate"], inject: { tool: "math.evaluate", mode: "always-fail" } },
  { id: "f03", category: "failure", objective: "What is (17+25)*2?", needs: [{ kind: "math", value: 84 }], expectTools: ["math.evaluate"], inject: { tool: "math.evaluate", mode: "fail-first" } },
  { id: "f04", category: "failure", objective: "What time is it?", needs: [{ kind: "time", zone: "local" }], expectTools: ["system.time"], inject: { tool: "system.time", mode: "hang" } },
];
