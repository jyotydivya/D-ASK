import { memoryService } from "../lib/agent/memory/memoryService";
import { embeddingService } from "../lib/agent/memory/embeddingService";

async function main() {
  console.log("Testing Memory System...");

  // 1. Test Preferences
  console.log("--- Preferences ---");
  memoryService.storePreference("theme", "dark");
  memoryService.storePreference("username", "Divya");
  
  const theme = memoryService.getPreference("theme");
  const username = memoryService.getPreference("username");
  console.log(`Stored Theme: ${theme}`);
  console.log(`Stored Username: ${username}`);
  
  if (theme !== "dark" || username !== "Divya") {
    throw new Error("Preferences test failed");
  }

  // 2. Test Semantic Memories
  console.log("\n--- Semantic Memories ---");
  const memoriesToStore = [
    "The user loves to drink black coffee in the morning.",
    "The user is building a JARVIS-style AI assistant named D-ASK.",
    "The user's favorite programming language is TypeScript.",
  ];

  for (const text of memoriesToStore) {
    console.log(`Storing memory: "${text}"`);
    const embedding = await embeddingService.generateEmbedding(text);
    memoryService.storeMemory(text, embedding);
  }

  // 3. Search Memories
  console.log("\n--- Searching Memories ---");
  const query = "What kind of beverage does the user enjoy?";
  console.log(`Query: "${query}"`);
  
  const queryEmbedding = await embeddingService.generateEmbedding(query);
  const results = memoryService.searchMemories(queryEmbedding, 2);
  
  for (const result of results) {
    console.log(`- [Similarity: ${result.similarity?.toFixed(4)}] ${result.text}`);
  }

  // The first result should be about coffee
  if (results.length > 0 && results[0].text.includes("coffee")) {
    console.log("\n✅ Memory System Test Passed!");
  } else {
    console.log("\n❌ Memory System Test Failed! Did not retrieve expected memory.");
  }
}

main().catch(console.error);
