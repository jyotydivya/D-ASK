// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/[id]/approve — Resolve a pending human approval gate
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { taskService } from "../../../../../services/taskService";
import { eventService } from "../../../../../services/eventService";
import type { ApproveTaskRequest, ApproveTaskResponse } from "../../../../../agent/types";

export const runtime = "nodejs";


export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: taskId } = await params;
    const body = (await request.json()) as ApproveTaskRequest;

    if (!taskId) {
      return NextResponse.json({ error: "Missing task ID" }, { status: 400 });
    }

    if (!body.approvalId || !body.decision) {
      return NextResponse.json(
        { error: "approvalId and decision are required" },
        { status: 400 }
      );
    }

    if (!["approved", "rejected"].includes(body.decision)) {
      return NextResponse.json(
        { error: "decision must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }

    const approval = taskService.getApproval(body.approvalId);
    if (!approval) {
      return NextResponse.json(
        { error: `Approval ${body.approvalId} not found` },
        { status: 404 }
      );
    }

    if (approval.taskId !== taskId) {
      return NextResponse.json(
        { error: "Approval does not belong to this task" },
        { status: 403 }
      );
    }

    if (approval.status !== "pending") {
      return NextResponse.json(
        { error: `Approval already resolved: ${approval.status}` },
        { status: 409 }
      );
    }

    const resolved = taskService.resolveApproval(
      body.approvalId,
      body.decision,
      body.note
    );

    eventService.publish(taskId, "approval.completed", {
      approvalId: body.approvalId,
      decision: body.decision,
      tool: approval.toolName,
      note: body.note,
    });

    const taskResumed = body.decision === "approved";

    const response: ApproveTaskResponse = {
      success: true,
      taskResumed,
    };

    return NextResponse.json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/tasks/[id]/approve]", error);
    return NextResponse.json({ error }, { status: 500 });
  }
}
