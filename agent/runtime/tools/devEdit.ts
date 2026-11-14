/**
 * dev.edit_file (2026-11-14): ONE exact replacement in ONE source file, as the request quotes it:
 *   In D:\proj\calc.js, replace "return a + b" with "return a - b"
 *   Replace "foo" with "bar" in D:\proj\src\x.ts [and run the tests in D:\proj]
 * The daemon shows the diff for approval, writes once, reads back (nothing else may change). "… and run the tests in <folder>" then asks
 * for the existing dev.run_task (its own approval, same process containment): the edit is reported with the real test result.
 */
import { contentWords } from "../grounding";
import type { ArgumentDomain, GroundingVerdict, ToolSpec } from "../types";
import type { DesktopBridge, DesktopReply } from "./desktop";

export interface DevEditRequest { file: string; find: string; replace: string; testFolder: string | null }
const Q = String.raw`["“]([^"”]{1,2000})["”]`;
const PATH = String.raw`["“]?([A-Za-z]:\\[^"”\r\n,]{1,240}?)["”]?`;
const TESTS = String.raw`(?:,?\s+(?:and|then)\s+(?:then\s+)?run\s+(?:the\s+)?tests\s+(?:in|of|for)\s+${PATH})?`;
const A = new RegExp(String.raw`^\s*(?:please\s+)?in\s+${PATH},?\s+replace\s+${Q}\s+with\s+${Q}${TESTS}\s*[.!]?\s*$`, "i");
const B = new RegExp(String.raw`^\s*(?:please\s+)?(?:replace|change)\s+${Q}\s+(?:with|to)\s+${Q}\s+in\s+(?:the\s+file\s+)?${PATH}${TESTS}\s*[.!]?\s*$`, "i");

export function devEditRequest(o: string): DevEditRequest | null {
  let m = A.exec(o);
  if (m) return { file: m[1]!.trim(), find: m[2]!, replace: m[3]!, testFolder: m[4]?.trim() ?? null };
  m = B.exec(o);
  if (m) return { file: m[3]!.trim(), find: m[1]!, replace: m[2]!, testFolder: m[4]?.trim() ?? null };
  return null;
}

async function call(bridge: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, ms: number) {
  if (!bridge.available) return { reply: null as DesktopReply | null, error: "Code edits are not available (the daemon did not enable them)." };
  try { return { reply: await bridge.call(ctx.taskId, tool, args, ctx.signal, ms), error: null }; }
  catch (e) { return { reply: null, error: e instanceof Error ? e.message : String(e) }; }
}

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });

export function createDevEditTool(bridge: DesktopBridge): ToolSpec<{ file: string; find: string; replace: string; testFolder?: string }, any> {
  const req = (o: string) => (bridge.offers && !bridge.offers("dev.edit_file") ? null : devEditRequest(o));
  const mine = (o: string) => req(o) !== null;
  return {
    name: "dev.edit_file",
    description: "Replace exactly the quoted text (it must occur once) with the quoted replacement in ONE source file the request names; the user approves the diff; the file is read back; optionally the project's tests are then run (separate approval).",
    inputSchema: { type: "object", properties: { file: { type: "string", maxLength: 260 }, find: { type: "string", maxLength: 2000 }, replace: { type: "string", maxLength: 2000 }, testFolder: { type: "string", maxLength: 260 } }, required: ["file", "find", "replace"] },
    permissions: ["request:desktop_action"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 800_000,
    async execute(input, ctx) {
      const { reply, error } = await call(bridge, "dev.edit_file", { file: input.file, find: input.find, replace: input.replace }, ctx, 75_000);
      if (!reply) return { ok: false, error: error!, evidence: "" };
      if (reply.status !== "ok") return { ok: false, error: reply.error?.message ?? "Nothing was changed.", evidence: "" };
      const r = (reply.result ?? {}) as any;
      if (r.verified !== true) return { ok: false, output: r, error: "The edit was not confirmed.", evidence: "" };
      let evidence = `Edited ${r.file}: ${r.observed}.\n${r.diff}\nBackup of the original: ${r.backup}`;
      if (input.testFolder) {
        const t = await call(bridge, "dev.run_task", { folder: input.testFolder, task: "test" }, ctx, 715_000);
        const tr = (t.reply?.result ?? {}) as any;
        if (!t.reply || t.reply.status !== "ok" || tr.verified !== true)
          return { ok: false, output: { ...r, tests: tr }, error: `${evidence}\nThe tests were not run: ${t.reply?.error?.message ?? t.error ?? "not confirmed"}.`, evidence: "" };
        evidence += `\nTests (${tr.command}): ${tr.observed}${tr.summary?.length ? ` — ${tr.summary.join(" | ")}` : ""}${tr.errors?.length ? `\n${tr.errors.slice(0, 10).map((e: string) => `- ${e}`).join("\n")}` : ""}`;
        return tr.succeeded === true ? { ok: true, output: { ...r, tests: tr }, evidence } : { ok: false, output: { ...r, tests: tr }, error: `${evidence}\nThe edit is in place, but the tests FAIL.`, evidence: "" };
      }
      return { ok: true, output: r, evidence };
    },
    check: (_i, outcome) => (outcome.output?.verified === true ? { ok: true } : { ok: false, reason: "the edit was not confirmed" }),
    requestCheck: {
      argumentDomains: (o): Record<string, ArgumentDomain> => {
        const r = req(o);
        if (!r) return { file: { kind: "forbidden", reason: "the request does not ask for a code edit" } };
        return { file: { kind: "enum", values: [r.file], optional: false }, find: { kind: "enum", values: [r.find], optional: false }, replace: { kind: "enum", values: [r.replace], optional: false },
          testFolder: r.testFolder ? { kind: "enum", values: [r.testFolder], optional: false } : { kind: "forbidden", reason: "the request does not ask to run tests" } };
      },
      relevant: mine,
      claims: mine,
      facets: (o) => (mine(o) ? [{ id: `dev:edit:${req(o)!.file.toLowerCase()}`, tool: "dev.edit_file", description: `edit ${req(o)!.file}`, data: req(o)! }] : []),
      ground: (input, o) => {
        const r = req(o);
        if (!r) return ungrounded("the request does not ask for a code edit");
        return input.file === r.file && input.find === r.find && input.replace === r.replace && (input.testFolder ?? null) === r.testFolder
          ? grounded("file, text and replacement are exactly the request's") : contradicted("use exactly the quoted file, text and replacement");
      },
      satisfies: (_f, _i, outcome) => outcome.ok && outcome.output?.verified === true,
      stepFor: (f, o) => { const r = req(o); return f.tool === "dev.edit_file" && r ? { file: r.file, find: r.find, replace: r.replace, ...(r.testFolder ? { testFolder: r.testFolder } : {}) } : null; },
      vocabulary: (o) => [...contentWords(o)],
    },
  };
}
