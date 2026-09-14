// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Event Service — In-memory pub/sub with SSE support
// Phase 1: Map-based (replace with Redis pub/sub in Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskEvent, TaskEventType } from "../agent/types";

type EventHandler = (event: TaskEvent) => void;

// Global singleton — survives module scope in Next.js dev server
const subscribers = new Map<string, Set<EventHandler>>();
const eventHistory = new Map<string, TaskEvent[]>(); // last 200 events per task

const MAX_HISTORY = 200;

function generateId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const eventService = {
  /**
   * Subscribe to events for a specific task.
   * Returns an unsubscribe function.
   */
  subscribe(taskId: string, handler: EventHandler): () => void {
    if (!subscribers.has(taskId)) {
      subscribers.set(taskId, new Set());
    }
    subscribers.get(taskId)!.add(handler);

    return () => {
      const set = subscribers.get(taskId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          subscribers.delete(taskId);
        }
      }
    };
  },

  /**
   * Publish an event to all subscribers for a task.
   * Also persists to history.
   */
  publish(
    taskId: string,
    type: TaskEventType,
    payload: Record<string, unknown> = {}
  ): TaskEvent {
    const event: TaskEvent = {
      id: generateId(),
      taskId,
      type,
      timestamp: new Date(),
      payload,
    };

    // Persist to history
    if (!eventHistory.has(taskId)) {
      eventHistory.set(taskId, []);
    }
    const history = eventHistory.get(taskId)!;
    history.push(event);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Dispatch to subscribers
    const handlers = subscribers.get(taskId);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Individual handler errors should not break the chain
        }
      }
    }

    return event;
  },

  /**
   * Get event history for a task.
   */
  getHistory(taskId: string, limit = 50): TaskEvent[] {
    const history = eventHistory.get(taskId) ?? [];
    return history.slice(-limit);
  },

  /**
   * Create a ReadableStream for SSE that streams events for a task.
   * Automatically sends buffered history first, then live events.
   */
  createSSEStream(taskId: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

    return new ReadableStream({
      start(controller) {
        controllerRef = controller;

        // Send heartbeat comment to establish connection
        controller.enqueue(encoder.encode(": connected\n\n"));

        // Send buffered history so client can catch up
        const history = eventService.getHistory(taskId, MAX_HISTORY);
        for (const event of history) {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        // If task is already terminal, close immediately
        const isTerminal =
          history.length > 0 &&
          ["task.completed", "task.failed", "task.cancelled"].includes(
            history[history.length - 1]!.type
          );

        if (isTerminal) {
          controller.close();
          return;
        }

        // Subscribe to live events
        unsubscribe = eventService.subscribe(taskId, (event) => {
          try {
            const line = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(line));

            // Close stream when task reaches terminal state
            if (
              event.type === "task.completed" ||
              event.type === "task.failed" ||
              event.type === "task.cancelled"
            ) {
              setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              }, 500);
            }
          } catch {
            // Controller might be closed
          }
        });

        // Heartbeat to keep connection alive (every 15 seconds)
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15_000);

        // Store heartbeat cleanup reference via closure
        const originalUnsubscribe = unsubscribe;
        unsubscribe = () => {
          originalUnsubscribe?.();
          clearInterval(heartbeat);
        };
      },

      cancel() {
        unsubscribe?.();
        unsubscribe = null;
        controllerRef = null;
      },
    });
  },

  /**
   * Clear event history for a task (cleanup after completion).
   */
  clearHistory(taskId: string): void {
    eventHistory.delete(taskId);
  },

  /**
   * Get the number of active subscribers for a task.
   */
  subscriberCount(taskId: string): number {
    return subscribers.get(taskId)?.size ?? 0;
  },
};
