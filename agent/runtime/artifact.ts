// ─────────────────────────────────────────────────────────────────────────────
// Typed intermediate results. A run's artifact is taken from what a TOOL returned (its typed output), never from the model's prose:
//   browser.read_page     -> page        (title + text, source = the final URL, online)
//   filesystem.summarize  -> file-summary (key sentences with line numbers, source = the file)
//   filesystem.read       -> file-text    (the exact text read, source = the file and line range)
//   desktop.read_text     -> window-text  (recognised lines, source = the window)
//   memory.recall         -> memory       (the saved memories found)
// The knowledge engine sets its own artifacts (answer with citations, passages, saved report). Anything else falls back to the run's
// response as plain "text", which is still provenance-tagged (tool, request, outcome, verification).
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import type { Artifact, RunReport } from "./types";

const MAX_TEXT = 6000;
const cut = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

export function artifactOf(report: RunReport, objective: string): Artifact {
  if (report.artifact) return report.artifact;
  const verified = report.verification ? report.verification.independentlyVerified : null;
  const base = (tool: string, online = false) => ({ tool, objective, outcome: report.outcome, verified, online, at: new Date().toISOString() });
  for (const s of [...report.steps].reverse()) {
    if (s.status !== "succeeded" || !s.outcome?.ok) continue;
    // A sandboxed plugin's own text (never verified: the label says so), without the run's other wording (found in the real HUD: "… and remember
    // it" passed the whole noisy response, which then did not verify).
    if (s.step.tool.startsWith("plugin_") && typeof s.outcome.evidence === "string") {
      const text = s.outcome.evidence.replace(/^\[plugin [^\]]*\]\s*/, "").trim();
      if (text) return { kind: "plugin-output", text: cut(text), sources: [{ label: `plugin ${s.step.tool.slice(7).split(".")[0]}`, ref: s.step.tool }], provenance: { ...base(s.step.tool), verified: false } };
    }
    const o = s.outcome.output as Record<string, any> | undefined;
    if (!o || typeof o !== "object") continue;
    switch (s.step.tool) {
      case "browser.read_page":
        if (typeof o.text === "string" && typeof o.finalUrl === "string")
          return { kind: "page", text: cut(`${o.title ? o.title + "\n" : ""}${o.text}`), sources: [{ label: String(o.title || o.finalUrl), ref: o.finalUrl }], provenance: base(s.step.tool, true) };
        break;
      case "filesystem.summarize":
        if (Array.isArray(o.keySentences) && o.keySentences.length)
          return { kind: "file-summary", text: cut(o.keySentences.map((k: { line: number; text: string }) => `${k.text} (line ${k.line})`).join("\n")),
            sources: [{ label: path.basename(String(o.canonicalPath ?? o.path)), ref: String(o.canonicalPath ?? o.path) }], provenance: base(s.step.tool), file: String(o.canonicalPath ?? o.path) };
        break;
      case "filesystem.read":
        if (typeof o.text === "string")
          return { kind: "file-text", text: cut(o.text), sources: [{ label: `${path.basename(String(o.canonicalPath))} lines ${o.startLine}-${o.endLine}`, ref: String(o.canonicalPath) }], provenance: base(s.step.tool), file: String(o.canonicalPath) };
        break;
      case "desktop.read_text":
        if (Array.isArray(o.lines))
          return { kind: "window-text", text: cut(o.lines.map((l: { text: string }) => l.text).join("\n")), sources: [{ label: `window "${o.window?.title ?? "?"}"`, ref: String(o.window?.process ?? "") }], provenance: base(s.step.tool) };
        break;
      case "memory.recall":
        if (Array.isArray(o.hits) && o.hits.length)
          return { kind: "memory", text: o.hits.map((h: { content: string }) => h.content).join("\n"), sources: o.hits.map((h: { id: string }) => ({ label: "saved memory", ref: String(h.id).slice(0, 8) })), provenance: base(s.step.tool) };
        break;
    }
  }
  const tools = report.steps.filter((s) => s.status === "succeeded").map((s) => s.step.tool);
  return { kind: "text", text: cut(report.response), sources: [], provenance: base(tools.at(-1) ?? (report.outcome === "answered" ? "local-model" : "runtime")) };
}

/** "Sources:" lines for a note, unless the text already carries its own source list. */
export function sourceLines(a: Artifact): string {
  if (!a.sources.length || /\nSources:\n/.test(a.text)) return "";
  const src = a.sources.slice(0, 8).map((s) => `- ${s.label}${s.ref && s.ref !== s.label ? ` (${s.ref}${s.page ? `, p. ${s.page}` : ""})` : ""}`);
  return `\n\nSources:\n${src.join("\n")}`;
}
