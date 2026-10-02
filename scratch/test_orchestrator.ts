import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?/);
  if (m && m[1] && m[2]) process.env[m[1]] = m[2];
}

import { taskService } from "../services/taskService";
import { orchestrator } from "../agent/orchestrator";
import { eventService } from "../services/eventService";

async function main() {
  console.log("Testing orchestrator task flow...");
  const task = taskService.createTask("Open Notepad on my PC", "test_session", "normal");
  console.log("Created task:", task.id);

  eventService.subscribe(task.id, (event) => {
    console.log(`[EVENT] ${event.type}:`, JSON.stringify(event.payload));
  });

  try {
    await (orchestrator as any).runInternal(task.id);
    console.log("Task completed successfully!");
  } catch (err: any) {
    console.error("Task failed with error:", err.message);
  }
}

main().catch(console.error);
