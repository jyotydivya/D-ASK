// Plugin management requests (agent side). The daemon validates, shows the approval card, and keeps the approved list;
// these tools only ask. The model supplies only the plugin id, pinned to the request.

import type { ArgumentDomain, GroundingVerdict, ToolRequestCheck, ToolSpec } from "../types";
import type { DesktopBridge } from "./desktop";

const ID = String.raw`["“']?([a-z][a-z0-9_]{1,30})["”']?`;
const INSTALL = new RegExp(String.raw`^\s*(?:please\s+)?(?:install|enable|approve|add)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const REMOVE = new RegExp(String.raw`^\s*(?:please\s+)?(?:remove|uninstall|disable|revoke)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const LIST = /^\s*(?:please\s+)?(?:list|show|which|what)\b.*\bplugins?\b/i;
export const installedPlugin = (o: string) => INSTALL.exec(o)?.[1] ?? null;
export const removedPlugin = (o: string) => REMOVE.exec(o)?.[1] ?? null;
export const isListPlugins = (o: string) => LIST.test(o) && !installedPlugin(o) && !removedPlugin(o);

const grounded = (r: string): GroundingVerdict => ({ status: "grounded", reason: r });
const VOCAB = ["install", "enable", "approve", "add", "remove", "uninstall", "disable", "revoke", "the", "plugin", "plugins", "called", "named", "list",
  "show", "which", "what", "are", "my", "installed", "please"];

function idCheck(tool: string, idOf: (o: string) => string | null, ok: (out: any) => boolean): ToolRequestCheck<{ id?: string }, any> {
  return {
    argumentDomains: (o): Record<string, ArgumentDomain> => { const id = idOf(o); return { id: id ? { kind: "enum", values: [id], optional: false } : { kind: "forbidden", reason: "the request names no plugin for this" } }; },
    relevant: (o) => idOf(o) !== null,
    claims: (o) => idOf(o) !== null,
    facets: (o) => { const id = idOf(o); return id ? [{ id: `${tool}:${id}`, tool, description: `${tool.split(".")[1]} the plugin ${id}`, data: id }] : []; },
    ground: (i, o) => (idOf(o) === i.id ? grounded("the plugin named in the request") : { status: "contradicted", reason: `the request names ${idOf(o) ?? "no plugin"}` }),
    satisfies: (f, i, outcome) => outcome.ok && i.id === f.data && ok(outcome.output),
    vocabulary: (o) => [...VOCAB, ...(idOf(o) ?? "").split("_")],
  };
}

const fail = (error: string) => ({ ok: false as const, error, evidence: "" });
async function call(b: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, ms: number) {
  if (!b.available || (b.offers && !b.offers(tool))) return "Plugins are not enabled (AgentHost:Plugins).";
  try { return await b.call(ctx.taskId, tool, args, ctx.signal, ms); } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const idSchema = { type: "object" as const, properties: { id: { type: "string" as const, minLength: 2, maxLength: 31 } }, required: ["id"] };

export function createPluginTools(bridge: DesktopBridge): ToolSpec<any, any>[] {
  return [
    {
      name: "plugin.install", description: "Ask the user (in the HUD) to approve installing ONE plugin they name, from D-ASK's plugins folder. Compute-only, sandboxed.",
      inputSchema: idSchema, permissions: ["request:desktop_action"], risk: "medium", requiresApproval: false, timeoutMs: 90_000,
      async execute(input: { id: string }, ctx) {
        const r = await call(bridge, "plugins.approve", { id: input.id }, ctx, 80_000);
        if (typeof r === "string") return fail(r);
        if (r.status !== "ok") return fail(r.error?.message ?? "Not installed.");
        return { ok: true, output: r.result, evidence: `Installed the plugin ${r.result?.id} ${r.result?.version} (tools: ${(r.result?.tools ?? []).join(", ")}); it runs compute-only in D-ASK's sandbox and is re-checked before every run.` };
      },
      requestCheck: idCheck("plugin.install", installedPlugin, (o) => o?.verified === true),
    },
    {
      name: "plugin.remove", description: "Remove (revoke) ONE installed plugin the user names.",
      inputSchema: idSchema, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
      async execute(input: { id: string }, ctx) {
        const r = await call(bridge, "plugins.revoke", { id: input.id }, ctx, 8_000);
        if (typeof r === "string") return fail(r);
        if (r.status !== "ok") return fail(r.error?.message ?? "Not removed.");
        return { ok: true, output: r.result, evidence: `Removed the plugin ${r.result?.id}; its tools are no longer available.` };
      },
      requestCheck: idCheck("plugin.remove", removedPlugin, (o) => o?.revoked === true),
    },
    {
      name: "plugin.list", description: "List the plugins in D-ASK's plugins folder: installed or not, intact or changed.",
      inputSchema: { type: "object", properties: {} }, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
      async execute(_i, ctx) {
        const r = await call(bridge, "plugins.list", {}, ctx, 8_000);
        if (typeof r === "string") return fail(r);
        if (r.status !== "ok") return fail(r.error?.message ?? "Could not list plugins.");
        const ps = (r.result?.plugins ?? []) as any[];
        return { ok: true, output: r.result, evidence: ps.length ? ps.map((p) => `${p.id}${p.version ? ` ${p.version}` : ""}: ${p.approved ? (p.intact ? "installed" : "installed, but changed since approval (disabled)") : "not installed"}${p.problem ? ` (${p.problem})` : ""}`).join("\n") : "No plugins in the plugins folder." };
      },
      requestCheck: {
        argumentDomains: () => ({}), relevant: isListPlugins, claims: isListPlugins,
        facets: (o) => (isListPlugins(o) ? [{ id: "plugin.list", tool: "plugin.list", description: "list the plugins", data: null }] : []),
        ground: (_i, o) => (isListPlugins(o) ? grounded("asked to list plugins") : { status: "ungrounded", reason: "not asked" }),
        satisfies: (_f, _i, outcome) => outcome.ok && Array.isArray(outcome.output?.plugins), vocabulary: () => VOCAB,
      },
    },
  ];
}
