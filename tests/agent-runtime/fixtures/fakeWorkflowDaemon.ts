// A fake daemon that mirrors the real WorkflowService contract closely enough to test the host: exact-name lookup, the daemon's own argument
// validation (name pattern, 1-8 steps, no recursion, HH:mm, kind/day/date rules), an approval-gated schedule (the "card"), and read-only list/get.
import type { DesktopReply } from "../../../agent/runtime/tools/desktop";

export interface WorldWorkflow { name: string; steps: string[]; schedule: string | null }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/;
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export class FakeWorkflowDaemon {
  available = true;
  enabled = true;
  approve = true;
  cardShown = 0;
  /** Every daemon call EXCEPT the host's own read-only list at the start of each task (it only learns the saved names). */
  calls: { tool: string; args: any }[] = [];
  fetches = 0;
  private readonly seenTasks = new Set<string>();
  store = new Map<string, WorldWorkflow>();
  private readonly tools = ["workflows.save", "workflows.list", "workflows.get", "workflows.delete", "workflows.schedule", "workflows.unschedule"];
  constructor(world: readonly WorldWorkflow[] = []) { this.reset(world); }
  reset(world: readonly WorldWorkflow[]) { this.store = new Map(world.map((w) => [w.name.toLowerCase(), { ...w, steps: [...w.steps] }])); this.calls = []; this.fetches = 0; this.seenTasks.clear(); this.cardShown = 0; }
  /** Calls that are the request's own action (the host's initial list fetch is counted in `fetches`). */
  get actions() { return this.calls; }
  offers(t: string) { return this.enabled && this.tools.includes(t); }
  attach() {} enable() {} failAll() {} onReply() {} offered() { return null; }
  private err(code: string, message: string): DesktopReply { return { status: "error", error: { code, message } }; }
  async call(task: string, tool: string, args: any): Promise<DesktopReply> {
    if (tool === "workflows.list" && !this.seenTasks.has(task)) { this.seenTasks.add(task); this.fetches++; }
    else { this.seenTasks.add(task); this.calls.push({ tool, args: structuredClone(args) }); }
    const key = String(args?.name ?? "").toLowerCase(); const w = this.store.get(key);
    const nf = () => this.err("not_found", "There is no workflow with that name.");
    switch (tool) {
      case "workflows.save": {
        if (typeof args.name !== "string" || !NAME.test(args.name)) return this.err("invalid_args", "a workflow name is 1 to 40 letters, digits, spaces, '.', '_' or '-'");
        if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 8 || args.steps.some((s: unknown) => typeof s !== "string" || s.trim().length < 3 || s.length > 300 || /workflow|\bschedul/i.test(s)))
          return this.err("invalid_args", "a workflow has 1 to 8 steps of 3 to 300 characters that do not run or schedule workflows");
        if (w) return this.err("exists", `A workflow called "${args.name}" already exists; delete it first to replace it.`);
        this.store.set(key, { name: args.name, steps: args.steps, schedule: null });
        return { status: "ok", result: { saved: true, name: args.name, steps: args.steps } };
      }
      case "workflows.list": return { status: "ok", result: { workflows: [...this.store.values()].map((x) => ({ name: x.name, steps: x.steps.length, schedule: x.schedule })) } };
      case "workflows.delete": if (!w) return nf(); this.store.delete(key); return { status: "ok", result: { deleted: true, name: w.name, hadSchedule: w.schedule !== null } };
      case "workflows.unschedule": if (!w) return nf(); if (!w.schedule) return this.err("not_scheduled", `"${w.name}" is not scheduled.`); w.schedule = null; return { status: "ok", result: { unscheduled: true, name: w.name } };
      case "workflows.schedule": {
        if (!w) return nf();
        if (!["daily", "weekly", "once"].includes(args.kind) || typeof args.time !== "string" || !TIME.test(args.time)) return this.err("invalid_args", "kind is daily, weekly or once; time is HH:mm");
        if ((args.kind === "weekly") !== (args.day !== undefined) || (args.day !== undefined && !DAYS.includes(args.day))) return this.err("invalid_args", "a weekly schedule names exactly one day");
        if ((args.kind === "once") !== (args.date !== undefined) || (args.date !== undefined && !DATE.test(args.date))) return this.err("invalid_args", "a one-off schedule names exactly one date");
        this.cardShown++;   // the daemon's approval card
        if (!this.approve) return this.err("approval_denied", "The schedule was not approved. Nothing was scheduled.");
        w.schedule = args.kind === "daily" ? `every day at ${args.time}` : args.kind === "weekly" ? `every ${args.day} at ${args.time}` : `once, on ${args.date} at ${args.time}`;
        return { status: "ok", result: { decision: "approved", consumed: true, executed: true, verified: true, name: w.name, when: w.schedule, firstRun: "2026-11-12 09:00" } };
      }
    }
    return this.err("unknown_tool", "x");
  }
}
