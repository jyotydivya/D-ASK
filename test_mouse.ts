import { mouseKeyboardService } from "./lib/agent/tools/desktop/mouseKeyboard";
import { pcControlService } from "./lib/agent/tools/desktop/pcControl";

async function main() {
  console.log("Testing PC Control and Mouse/Keyboard Services...");
  const pos = await mouseKeyboardService.getMousePosition();
  console.log(`Current Mouse Position: x=${pos.x}, y=${pos.y}`);
  
  const activeWindow = await pcControlService.getActiveWindow();
  console.log(`Active Window: ${activeWindow}`);

  console.log("All tests passed.");
}

main().catch(console.error);
