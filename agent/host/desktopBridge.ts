// Phase 7B.1b: host side of protocol v2 (read-only). Sends `call` lines and matches the daemon's `reply` lines.
// It holds no authority: the daemon validates every call, and the bridge only carries a tool name and typed args.
// It is enabled only when the daemon offered v2 in hello; until then every call fails closed.

import type { DesktopBridge, DesktopReply as ToolReply } from "../runtime/tools/desktop";
import type { DesktopReply } from "./protocol";

interface Pending {
  resolve(r: ToolReply): void;
  reject(e: Error): void;
  cleanup(): void;
}

export class DaemonCallBridge implements DesktopBridge {
  private writeLine: ((line: string) => void) | null = null;
  private tools = new Set<string>();
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  /** True once the daemon offered v2 and at least one tool was agreed. */
  get available(): boolean { return this.tools.size > 0 && this.writeLine !== null; }

  attach(writeLine: (line: string) => void): void { this.writeLine = writeLine; }
  enable(tools: readonly string[]): void { this.tools = new Set(tools); }
  /** P1/P2: whether the daemon offered this tool (input tools are offered only when that input kind is enabled). */
  offers(tool: string): boolean { return this.tools.has(tool); }
  offered(): { proto: 2; tools: string[] } | null { return this.tools.size ? { proto: 2, tools: [...this.tools] } : null; }

  call(taskId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<ToolReply> {
    if (!this.available) return Promise.reject(new Error("Desktop observation is not enabled."));
    if (!this.tools.has(tool)) return Promise.reject(new Error("This operation is not available."));
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    const callId = `c${++this.seq}`;
    return new Promise<ToolReply>((resolve, reject) => {
      const send = (line: string) => this.writeLine!(line);
      const timer = setTimeout(() => {
        send(JSON.stringify({ v: 2, kind: "call.cancel", callId }));
        // Wait for the daemon's cancelled/deadline reply for a moment; then give up locally.
        setTimeout(() => this.fail(callId, new Error("The daemon did not answer in time.")), 1000).unref?.();
      }, timeoutMs);
      const onAbort = () => send(JSON.stringify({ v: 2, kind: "call.cancel", callId }));
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(callId, {
        resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); },
      });
      send(JSON.stringify({ v: 2, kind: "call", callId, taskId, tool, args, deadlineMs: Math.min(timeoutMs, 60_000) }));
    });
  }

  /** A reply from the daemon. Replies for unknown call ids are ignored (they were already settled). */
  onReply(r: DesktopReply): void {
    const p = this.pending.get(r.callId);
    if (!p) return;
    this.pending.delete(r.callId);
    p.cleanup();
    p.resolve({ status: r.status, result: r.result, error: r.error as ToolReply["error"] });
  }

  private fail(callId: string, e: Error): void {
    const p = this.pending.get(callId);
    if (!p) return;
    this.pending.delete(callId);
    p.cleanup();
    p.reject(e);
  }

  /** Disconnect / shutdown: every outstanding call fails. */
  failAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.fail(id, new Error(reason));
  }
}
