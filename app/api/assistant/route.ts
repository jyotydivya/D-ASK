import { NextResponse } from "next/server";
import { modelRouter } from "../../../agent/modelRouter";

const MAX_MESSAGE_LENGTH = 1_000;

export async function POST(request: Request) {
  let message: unknown;
  try {
    ({ message } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "A text message is required." }, { status: 400 });
  }

  const userPrompt = message.trim();

  if (userPrompt.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "Please keep requests under 1,000 characters." }, { status: 400 });
  }

  try {
    const systemPrompt = `You are D-ASK, a concise, helpful Iron Man style desktop AI assistant. Determine if the user wants to execute a command on their phone (like open youtube, lock, unlock), change your own UI theme (red alert, cyan, amber, emerald), control the UI (zoom in/out, mute, gestures), or just have a conversation. 

CRITICAL: If the user wants to execute a command on their COMPUTER/PC (like opening Paint, Word, Calculator, or modifying local files) OR if they want you to perform a complex multi-step task (like coding, browsing, memory), you MUST return actionType: "task".
DO NOT REFUSE TO EXECUTE PC COMMANDS. You DO have the ability to execute commands on the user's PC via your orchestrator. Never say you cannot execute commands for security reasons.

Reply in 1-2 short sentences. Be authoritative, sleek, and high-tech. If returning actionType: "task", your reply should acknowledge that you are initiating the requested protocol.

You MUST respond in raw JSON format matching this structure:
{
  "reply": "The spoken response to say back to the user.",
  "actionType": "device" | "orb" | "task" | "none",
  "actionCommand": "launch_app | unlock | lock | go_home | take_screenshot | volume_up | volume_down | search_youtube | status | theme | zoom_in | zoom_out | reset_view | mute | unmute | speech_on | speech_off | gestures_on | gestures_off | clear",
  "actionPayload": {
    "targetApp": "string",
    "theme": "amber" | "crimson" | "cyan" | "emerald",
    "searchQuery": "string"
  }
}`;

    const jsonResponse = await modelRouter.generateStructured<any>({
      tier: "fast",
      systemPrompt,
      userPrompt
    });
    
    return NextResponse.json(jsonResponse);

  } catch (error) {
    console.error("API Error:", error);

    // Detect rate limit (429 / RESOURCE_EXHAUSTED)
    const errStr = String(error);
    const isRateLimit = errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED") || errStr.includes("quota");
    if (isRateLimit) {
      // Extract retry delay if present
      const retryMatch = errStr.match(/retry.*?(\d+(?:\.\d+)?)\s*s/i);
      const retrySecs = retryMatch ? Math.ceil(parseFloat(retryMatch[1]!)) : 60;
      return NextResponse.json({
        reply: `API quota exceeded. Retry in ${retrySecs}s. Device commands (open/lock/volume) still work offline.`,
        actionType: "none",
        rateLimited: true,
        retryAfterSeconds: retrySecs,
      });
    }

    return NextResponse.json({ 
        reply: "My neural net encountered an error connecting to the core.",
        actionType: "none"
    });
  }
}
