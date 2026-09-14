import { browserControlService } from "../lib/agent/tools/web/browserControl";

async function main() {
  console.log("Testing Browser Control Service...");

  try {
    console.log("Navigating to Wikipedia...");
    await browserControlService.navigate("https://www.wikipedia.org");
    console.log("Navigation successful.");

    console.log("Typing 'Artificial Intelligence' into the search bar...");
    await browserControlService.type("input#searchInput", "Artificial Intelligence");
    console.log("Typing successful.");

    console.log("Pressing Enter to search...");
    await browserControlService.press("input#searchInput", "Enter");
    console.log("Search submitted.");

    // Wait a brief moment for the page to load
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log("Taking a screenshot...");
    const screenshot = await browserControlService.takeScreenshot();
    console.log(`Screenshot taken! Size: ${Math.round(screenshot.length / 1024)} KB`);
    
    console.log("Retrieving text content of the page...");
    const text = await browserControlService.getPageText();
    console.log(`Page text length: ${text.length} characters`);
    console.log(`First 100 characters: ${text.substring(0, 100).replace(/\n/g, ' ')}`);

    console.log("Closing browser...");
    await browserControlService.close();
    console.log("Browser closed successfully.");
    
  } catch (error) {
    console.error("Error during browser testing:", error);
    await browserControlService.close();
  }
}

main().catch(console.error);
