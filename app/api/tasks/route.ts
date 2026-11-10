// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks — Create and launch a new task
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { taskService } from "../../../services/taskService";
import { eventService } from "../../../services/eventService";
import type { CreateTaskRequest, CreateTaskResponse, TaskEngine } from "../../../agent/types";
import { requireAuth } from "../../../lib/security/apiAuth";
import { runRuntimeTask } from "../../../agent/runtime";
import { inferenceMode } from "../../../agent/runtime/inference/policy";

function resolveEngine(requested: unknown): TaskEngine | null {
  // Offline-first (default): the local agent runtime. The legacy orchestrator is
  // cloud-only and is reachable only with DASK_INFERENCE=cloud.
  if (requested === undefined) {
    if (inferenceMode() !== "cloud") return "runtime";
    return process.env.DASK_AGENT_ENGINE === "runtime" ? "runtime" : "legacy";
  }
  return requested === "legacy" || requested === "runtime" ? requested : null;
}

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const denied = requireAuth(request, "task");
  if (denied) return denied;
  try {
    const body = (await request.json()) as CreateTaskRequest;

    if (!body.objective?.trim()) {
      return NextResponse.json(
        { error: "objective is required" },
        { status: 400 }
      );
    }

    const engine = resolveEngine(body.engine);
    if (engine === null) {
      return NextResponse.json(
        { error: 'engine must be "legacy" or "runtime"' },
        { status: 400 }
      );
    }
    if (engine === "legacy" && inferenceMode() !== "cloud") {
      return NextResponse.json(
        { error: 'The legacy engine uses hosted models and is disabled while DASK_INFERENCE=local. Use engine "runtime".', unavailable: "cloud-inference-disabled" },
        { status: 409 }
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
      engine,
    });

    // Launch asynchronously — do NOT await
    if (engine === "runtime") {
      void runRuntimeTask(task.id);
    } else {
      // Legacy (cloud-only) orchestrator, loaded lazily so the offline path never
      // pulls in agent/modelRouter.ts or a cloud SDK. Reached only with DASK_INFERENCE=cloud.
      void import("../../../agent/orchestrator").then(({ orchestrator }) => orchestrator.run(task.id));
    }

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
  const denied = requireAuth(request, "task");
  if (denied) return denied;
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const tasks = taskService.listTasks(sessionId ?? undefined);
  return NextResponse.json({ tasks, total: tasks.length });
}
