import { NextResponse } from "next/server";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_MESSAGE_LENGTH = 1_000;

type ResponseContent = {
  type?: string;
  text?: string;
};

type OpenAIResponse = {
  output?: Array<{ content?: ResponseContent[] }>;
};

function generateJarvisFallbackReply(prompt: string): string {
  const clean = prompt.toLowerCase().trim();

  if (clean.includes("who are you") || clean.includes("what are you") || clean.includes("identity")) {
    return "I am D-ASK, your Iron Man holographic AI desktop assistant. I monitor system telemetry, process hand tracking gestures, and execute terminal commands.";
  }

  if (clean.includes("hello") || clean.includes("hi") || clean.includes("hey") || clean.includes("greetings")) {
    return "Greetings. D-ASK neural core is online and standing by. How may I assist your operations today?";
  }

  if (clean.includes("red alert") || clean.includes("alert") || clean.includes("danger")) {
    return "Red Alert protocol recognized. Core energy flare set to maximum warning matrix. All tracking nodes armed.";
  }

  if (clean.includes("cyan") || clean.includes("blue") || clean.includes("arc")) {
    return "Arc Reactor Cyan energy frequency engaged. Visual spectrum calibrated.";
  }

  if (clean.includes("amber") || clean.includes("gold") || clean.includes("default")) {
    return "Standard Ultron Amber color palette restored.";
  }

  if (clean.includes("status") || clean.includes("system check") || clean.includes("health")) {
    return "All D-ASK sub-routines operational. Neural core running at optimal frequency, MediaPipe hand landmarker ready, Web Audio sound synthesis active.";
  }

  if (clean.includes("help") || clean.includes("command") || clean.includes("control")) {
    return "You can speak or type commands like: STATUS, ZOOM IN, ZOOM OUT, RESET, GESTURES ON/OFF, RED ALERT, CYAN MODE, or ask me any question.";
  }

  const fallbackResponses = [
    `Analyzing "${prompt.slice(0, 40)}"... Processing request through D-ASK neural sub-routines. All parameters verified.`,
    `D-ASK query processed. Neural indexing complete for "${prompt.slice(0, 30)}". Standard protocols active.`,
    `Acknowledged. D-ASK visual core is synchronized to your command input. Ready for further instructions.`,
  ];

  return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
}

function getOutputText(response: OpenAIResponse) {
  return response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
}

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

  // If no OpenAI API Key configured, use the smart D-ASK JARVIS fallback generator
  if (!process.env.OPENAI_API_KEY) {
    const fallbackReply = generateJarvisFallbackReply(userPrompt);
    return NextResponse.json({ reply: fallbackReply });
  }

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        instructions:
          "You are D-ASK, a concise, helpful Iron Man style desktop AI assistant. Reply in plain text in at most 2-3 short sentences. Be authoritative, sleek, and high-tech.",
        input: userPrompt,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const fallbackReply = generateJarvisFallbackReply(userPrompt);
      return NextResponse.json({ reply: fallbackReply });
    }

    const data = (await response.json()) as OpenAIResponse;
    const reply = getOutputText(data);
    if (!reply) {
      const fallbackReply = generateJarvisFallbackReply(userPrompt);
      return NextResponse.json({ reply: fallbackReply });
    }

    return NextResponse.json({ reply });
  } catch {
    const fallbackReply = generateJarvisFallbackReply(userPrompt);
    return NextResponse.json({ reply: fallbackReply });
  }
}
