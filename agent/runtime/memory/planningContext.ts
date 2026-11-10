// Saved local memories as planning context (read-only, advisory).
//
// Safeguards:
//   - Only the user's OWN memories (source "user"): nothing an agent or a web page produced is ever fed back to the planner.
//   - Relevance: a memory must share at least MIN_SHARED distinct content words with the request (or every content word
//     of a very short request), on top of the FTS match. At most `limit` memories, each truncated.
//   - Not for memory commands themselves (remember / forget / recall): those tools answer with the store directly.
//   - Fenced as data, never instructions. Memories never become tool arguments: the request-derived argument domains,
//     grounding and approvals apply exactly as without them (a memory cannot name a window, file, text or site).
//   - Automatic use does not count as "use" (no ranking feedback loop); the run report lists which ids were offered.
//   - Local only: the text goes to the local model in this process's planning prompt and nowhere else.

import type { MemoryStore, MemoryKind } from "./memoryStore";
import { forgetSubject, isRecallRequest, rememberedContent } from "../tools/memory";

export interface PlanningMemory {
  contextFor(objective: string): { lines: string[]; ids: string[] };
}

const STOP = new Set(("a an the and or of to in on at for is are was were be been my me i you your it this that what who where when which how do does did about " +
  "with from as by please can could would should will open show tell find get make use using into then also just some any all").split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map(stem));
/** Light suffix folding so "reports" matches "report" (FTS already stems; this guards the overlap check only). */
function stem(w: string): string { return w.replace(/(?:ing|ed|es|s)$/u, "") || w; }

export const MEMORY_CONTEXT_KINDS: readonly MemoryKind[] = ["preference", "fact", "person", "project", "note"];

export function createPlanningMemory(store: MemoryStore, opts: { limit?: number; maxChars?: number; minShared?: number } = {}): PlanningMemory {
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 5);
  const maxChars = opts.maxChars ?? 200;
  const minShared = opts.minShared ?? 2;
  return {
    contextFor(objective) {
      const none = { lines: [], ids: [] };
      if (rememberedContent(objective) !== null || forgetSubject(objective) !== null || isRecallRequest(objective)) return none;
      const q = words(objective);
      if (q.size === 0) return none;
      const need = Math.min(minShared, q.size);
      let hits;
      try { hits = store.recall(objective, { limit: 10, kinds: [...MEMORY_CONTEXT_KINDS], touch: false }); } catch { return none; }
      const chosen = hits
        .filter((h) => h.source === "user")
        .filter((h) => { const m = words(h.content); let n = 0; for (const w of q) if (m.has(w)) n++; return n >= need; })
        .slice(0, limit);
      return {
        lines: chosen.map((h) => `- (${h.kind}, saved ${h.updatedAt.slice(0, 10)}) ${h.content.length > maxChars ? h.content.slice(0, maxChars - 1) + "…" : h.content}`),
        ids: chosen.map((h) => h.id),
      };
    },
  };
}
