import { visionControlService } from "./lib/agent/tools/desktop/visionControl";

async function main() {
  console.log("Testing Vision Control Service...");
  
  // Test 1: Find an element
  console.log("Finding the Visual Studio Code icon on the taskbar or screen...");
  try {
    const coords = await visionControlService.findElementOnScreen("the start button or Windows logo icon in the taskbar");
    console.log(`Found coordinates: x=${coords.x}, y=${coords.y}`);
  } catch (error) {
    console.error("Error finding element:", error);
  }

  // Test 2: Analyze screen
  console.log("\nAnalyzing screen text...");
  try {
    const text = await visionControlService.analyzeScreen("What is the title of the active window, and what are a few lines of text visible on the screen?");
    console.log(`Screen Analysis:\n${text}`);
  } catch (error) {
    console.error("Error analyzing screen:", error);
  }

  console.log("\nAll vision tests completed.");
}

main().catch(console.error);
