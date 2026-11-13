// Plugin management requests (agent side). The daemon validates, shows the approval card, and keeps the approved list;
// these tools only ask. The model supplies only the plugin id (and a permission name), each pinned to the request.
//
//   install / remove / enable / disable the plugin X
//   grant the plugin X the files.read permission          (approval card in the HUD)
//   revoke the files.read permission of the plugin X      (no card: taking a capability away)
//   list my plugins                                        (declared and granted permissions, enabled or not)

import type { ArgumentDomain, GroundingVerdict, ToolRequestCheck, ToolSpec } from "../types";
import type { DesktopBridge } from "./desktop";

const ID = String.raw`["“']?([a-z][a-z0-9_]{1,30})["”']?`;
const PERM = String.raw`["“']?(files\.read|memory\.read)["”']?`;
const INSTALL = new RegExp(String.raw`^\s*(?:please\s+)?(?:install|approve|add)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const REMOVE = new RegExp(String.raw`^\s*(?:please\s+)?(?:remove|uninstall|revoke)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const ENABLE = new RegExp(String.raw`^\s*(?:please\s+)?(?:enable|re-?enable|turn\s+on)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const DISABLE = new RegExp(String.raw`^\s*(?:please\s+)?(?:disable|turn\s+off)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const GRANT = new RegExp(String.raw`^\s*(?:please\s+)?(?:grant|give|allow)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s+(?:the\s+)?${PERM}(?:\s+permission)?\s*[.!]?\s*$`, "i");
const REVOKE_PERM = new RegExp(String.raw`^\s*(?:please\s+)?(?:revoke|remove|withdraw|take\s+away)\s+(?:the\s+)?${PERM}(?:\s+permission)?\s+(?:of|from)\s+(?:the\s+)?plugin\s+(?:called\s+|named\s+)?${ID}\s*[.!]?\s*$`, "i");
const LIST = /^\s*(?:please\s+)?(?:list|show|which|what)\b.*\bplugins?\b/i;
export const installedPlugin = (o: string) => INSTALL.exec(o)?.[1] ?? null;
export const removedPlugin = (o: string) => REMOVE.exec(o)?.[1] ?? null;
export const enabledPlugin = (o: string) => ENABLE.exec(o)?.[1] ?? null;
export const disabledPlugin = (o: string) => DISABLE.exec(o)?.[1] ?? null;
export const grantedPermission = (o: string): { id: string; permission: string } | null => { const m = GRANT.exec(o); return m ? { id: m[1]!, permission: m[2]!.toLowerCase() } : null; };
export const revokedPermission = (o: string): { id: string; permission: string } | null => { const m = REVOKE_PERM.exec(o); return m ? { id: m[2]!, permission: m[1]!.toLowerCase() } : null; };
const isManagement = (o: string) => !!(installedPlugin(o) || removedPlugin(o) || enabledPlugin(o) || disabledPlugin(o) || grantedPermission(o) || revokedPermission(o));
export const isListPlugins = (o: string) => LIST.test(o) && !isManagement(o);

const grounded = (r: string): GroundingVerdict => ({ status: "grounded", reason: r });
const VOCAB = ["install", "enable", "approve", "add", "remove", "uninstall", "disable", "revoke", "the", "plugin", "plugins", "called", "named", "list",
  "show", "which", "what", "are", "my", "installed", "please", "grant", "give", "allow", "permission", "of", "from", "turn", "on", "off", "withdraw", "take", "away", "files", "read", "memory"];

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

function permCheck(tool: string, parse: (o: string) => { id: string; permission: string } | null, ok: (out: any, perm: string) => boolean): ToolRequestCheck<{ id?: string; permission?: string }, any> {
  const forbid = { kind: "forbidden" as const, reason: "the request names no plugin and permission for this" };
  return {
    argumentDomains: (o): Record<string, ArgumentDomain> => { const p = parse(o); return p ? { id: { kind: "enum", values: [p.id], optional: false }, permission: { kind: "enum", values: [p.permission], optional: false } } : { id: forbid, permission: forbid }; },
    relevant: (o) => parse(o) !== null,
    claims: (o) => parse(o) !== null,
    facets: (o) => { const p = parse(o); return p ? [{ id: `${tool}:${p.id}:${p.permission}`, tool, description: `${tool.split(".")[1]} ${p.permission} for the plugin ${p.id}`, data: p }] : []; },
    ground: (i, o) => { const p = parse(o); return p && p.id === i.id && p.permission === i.permission ? grounded("the plugin and permission named in the request") : { status: "contradicted", reason: `the request names ${p ? `${p.permission} for ${p.id}` : "no plugin permission"}` }; },
    satisfies: (f, i, outcome) => { const d = f.data as { id: string; permission: string }; return outcome.ok && i.id === d.id && i.permission === d.permission && ok(outcome.output, d.permission); },
    vocabulary: (o) => [...VOCAB, ...(parse(o)?.id ?? "").split("_")],
  };
}

const fail = (error: string) => ({ ok: false as const, error, evidence: "" });
async function call(b: DesktopBridge, tool: string, args: Record<string, unknown>, ctx: { taskId: string; signal: AbortSignal }, ms: number) {
  if (!b.available || (b.offers && !b.offers(tool))) return "Plugins are not enabled (AgentHost:Plugins).";
  try { return await b.call(ctx.taskId, tool, args, ctx.signal, ms); } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const idSchema = { type: "object" as const, properties: { id: { type: "string" as const, minLength: 2, maxLength: 31 } }, required: ["id"] };
const permSchema = { type: "object" as const, properties: { id: { type: "string" as const, minLength: 2, maxLength: 31 }, permission: { type: "string" as const, minLength: 4, maxLength: 20 } }, required: ["id", "permission"] };

/** One line per plugin, in a stable shape the HUD's plugin panel reads. Permissions: every declared one, granted or not. */
export function pluginLine(p: any): string {
  const status = p.approved ? (p.intact ? (p.enabled === false ? "installed, disabled" : "installed, enabled") : "installed, but changed since approval (disabled)") : "not installed";
  const declared: string[] = Array.isArray(p.declared) ? p.declared : [];
  const granted: string[] = Array.isArray(p.granted) ? p.granted : [];
  const perms = declared.length ? ` — permissions: ${declared.map((d) => `${d}=${granted.includes(d) ? "granted" : "not granted"}`).join(", ")}` : "";
  const tools = Array.isArray(p.tools) && p.tools.length ? ` — tools: ${p.tools.join(", ")}` : "";
  return `• ${p.id}${p.version ? ` ${p.version}` : ""} — ${status}${perms}${tools}${p.problem ? ` (${p.problem})` : ""}`;
}

export function createPluginTools(bridge: DesktopBridge): ToolSpec<any, any>[] {
  const simple = (name: string, description: string, daemonTool: string, risk: "low" | "medium", ms: number, doneText: (r: any) => string, check: ToolRequestCheck<any, any>, schema: any = idSchema): ToolSpec<any, any> => ({
    name, description, inputSchema: schema, permissions: ["request:desktop_action"], risk, requiresApproval: false, timeoutMs: ms + 10_000,
    async execute(input: Record<string, unknown>, ctx) {
      const r = await call(bridge, daemonTool, input, ctx, ms);
      if (typeof r === "string") return fail(r);
      if (r.status !== "ok") return fail(r.error?.message ?? "Not done.");
      return { ok: true, output: r.result, evidence: doneText(r.result) };
    },
    requestCheck: check,
  });
  return [
    simple("plugin.install", "Ask the user (in the HUD) to approve installing ONE plugin they name, from D-ASK's plugins folder. Sandboxed; only compute is granted by this approval.",
      "plugins.approve", "medium", 80_000,
      (r) => `Installed the plugin ${r?.id} ${r?.version} (tools: ${(r?.tools ?? []).join(", ")}); it runs in D-ASK's sandbox with the compute permission only and is re-checked before every run. Other permissions it declares need their own approval.`,
      idCheck("plugin.install", installedPlugin, (o) => o?.verified === true)),
    simple("plugin.remove", "Remove (uninstall) ONE installed plugin the user names.", "plugins.revoke", "low", 8_000,
      (r) => `Removed the plugin ${r?.id}; its tools are no longer available.`, idCheck("plugin.remove", removedPlugin, (o) => o?.revoked === true)),
    simple("plugin.disable", "Switch ONE installed plugin off without removing it (its permissions are kept).", "plugins.disable", "low", 8_000,
      (r) => `Disabled the plugin ${r?.id}; it will not run until you enable it again.`, idCheck("plugin.disable", disabledPlugin, (o) => o?.disabled === true)),
    simple("plugin.enable", "Switch ONE installed, previously approved plugin back on.", "plugins.enable", "low", 8_000,
      (r) => `Enabled the plugin ${r?.id}.`, idCheck("plugin.enable", enabledPlugin, (o) => o?.enabled === true)),
    simple("plugin.grant", "Ask the user (in the HUD) to approve giving ONE installed plugin ONE extra permission it declares (files.read or memory.read).",
      "plugins.grant", "medium", 80_000,
      (r) => `The plugin ${r?.id} now has the ${r?.permission} permission (granted: ${(r?.granted ?? []).join(", ")}). D-ASK checks it every time the plugin uses it.`,
      permCheck("plugin.grant", grantedPermission, (o, perm) => o?.verified === true && Array.isArray(o?.granted) && o.granted.includes(perm)), permSchema),
    simple("plugin.revoke_permission", "Take ONE permission away from ONE installed plugin.", "plugins.revoke_permission", "low", 8_000,
      (r) => `The plugin ${r?.id} no longer has the ${r?.permission} permission (still granted: ${(r?.granted ?? []).join(", ")}).`,
      permCheck("plugin.revoke_permission", revokedPermission, (o, perm) => o?.revoked === true && Array.isArray(o?.granted) && !o.granted.includes(perm)), permSchema),
    {
      name: "plugin.list", description: "List the plugins in D-ASK's plugins folder: installed or not, enabled, intact or changed, and which permissions each declares and has been granted.",
      inputSchema: { type: "object", properties: {} }, permissions: ["request:desktop_action"], risk: "low", requiresApproval: false, timeoutMs: 10_000,
      async execute(_i, ctx) {
        const r = await call(bridge, "plugins.list", {}, ctx, 8_000);
        if (typeof r === "string") return fail(r);
        if (r.status !== "ok") return fail(r.error?.message ?? "Could not list plugins.");
        const ps = (r.result?.plugins ?? []) as any[];
        return { ok: true, output: r.result, evidence: ps.length ? ps.map(pluginLine).join("\n") : "No plugins in the plugins folder." };
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
