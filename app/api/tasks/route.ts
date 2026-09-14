// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks — Create and launch a new task
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { taskService } from "../../../services/taskService";
import { eventService } from "../../../services/eventService";
import { orchestrator } from "../../../agent/orchestrator";
import type { CreateTaskRequest, CreateTaskResponse } from "../../../agent/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateTaskRequest;

    if (!body.objective?.trim()) {
      return NextResponse.json(
        { error: "objective is required" },
        { status: 400 }
      );
    }

    const sessionId =
      body.sessionId ??
      request.headers.get("x-session-id") ??
      `session_${Date.now().toString(36)}`;

    const task = taskService.createTask(
      body.objective.trim(),
      sessionId,
      body.priority ?? "normal"
    );

    // Publish task.created event
    eventService.publish(task.id, "task.created", {
      taskId: task.id,
      objective: task.objective,
      priority: task.priority,
      sessionId,
    });

    // Launch orchestrator asynchronously — do NOT await
    void orchestrator.run(task.id);

    const response: CreateTaskResponse = {
      taskId: task.id,
      status: task.status,
      message: `Task "${task.objective.slice(0, 60)}" created. Connect to /api/tasks/${task.id}/events for live updates.`,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/tasks]", error);
    return NextResponse.json({ error }, { status: 500 });
  }
}

// ── GET /api/tasks — List all tasks for a session ────────────────────────────

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const tasks = taskService.listTasks(sessionId ?? undefined);
  return NextResponse.json({ tasks, total: tasks.length });
}
