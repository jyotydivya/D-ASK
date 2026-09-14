// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/[id]/events — Server-Sent Events stream for live task updates
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { eventService } from "../../../../../services/eventService";
import { taskService } from "../../../../../services/taskService";

export const runtime = "nodejs";

// Disable body parsing for streaming response
export const dynamic = "force-dynamic";


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  if (!taskId) {
    return new Response("Missing task ID", { status: 400 });
  }

  // Validate task exists
  const task = taskService.getTask(taskId);
  if (!task) {
    return new Response(
      JSON.stringify({ error: `Task ${taskId} not found` }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // Create SSE stream — buffers history then subscribes to live events
  const stream = eventService.createSSEStream(taskId);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
