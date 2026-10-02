import OpenAI from "openai";
import fs from "fs";

function getApiKey() {
  const env = fs.readFileSync(".env.local", "utf8");
  const m = env.match(/OPENROUTER_API_KEY="([^"]+)"/);
  return m ? m[1] : process.env.OPENROUTER_API_KEY;
}

async function main() {
  const apiKey = getApiKey();
  console.log("Using API key:", apiKey?.slice(0, 10) + "...");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const candidates = [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.5-flash",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
    "anthropic/claude-sonnet-latest"
  ];

  for (const model of candidates) {
    console.log(`\nTesting model: ${model}`);
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Reply with JSON: {\"status\": \"ok\"}" }],
        response_format: { type: "json_object" }
      });
      console.log(`✅ [${model}] response:`, res.choices[0]?.message?.content);
    } catch (err: any) {
      console.log(`❌ [${model}] failed:`, err.message);
    }
  }

  const groqMatch = fs.readFileSync(".env.local", "utf8").match(/GROQ_API_KEY="([^"]+)"/);
  const groqKey = groqMatch ? groqMatch[1] : process.env.GROQ_API_KEY;
  if (groqKey) {
    console.log("\nTesting Groq API...");
    try {
      const gRes = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${groqKey}` }
      });
      const gData: any = await gRes.json();
      console.log(`Groq response (${gRes.status}):`, gRes.ok ? "OK, models available: " + gData.data?.length : gData);
    } catch (e: any) {
      console.log("Groq test error:", e.message);
    }
  }
}

main().catch(console.error);
