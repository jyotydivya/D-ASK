// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/[id] — Get task state snapshot
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { taskService } from "../../../../services/taskService";
import { eventService } from "../../../../services/eventService";

export const runtime = "nodejs";


export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = taskService.getTaskSnapshot(id);

  if (!snapshot) {
    return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });
  }

  const recentEvents = eventService.getHistory(id, 50);

  return NextResponse.json({
    ...snapshot,
    recentEvents,
  });
}

// ── DELETE /api/tasks/[id] — Cancel a task ────────────────────────────────────

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = taskService.getTask(id);

  if (!task) {
    return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });
  }

  const terminalStates = ["completed", "failed", "cancelled"];
  if (terminalStates.includes(task.status)) {
    return NextResponse.json(
      { error: `Task is already in terminal state: ${task.status}` },
      { status: 409 }
    );
  }

  taskService.updateTaskStatus(id, "cancelled");
  eventService.publish(id, "task.cancelled", { taskId: id, reason: "User cancelled" });

  return NextResponse.json({ success: true, taskId: id, status: "cancelled" });
}
