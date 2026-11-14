// TEST HARNESS ONLY (never used by the product). Chrome 137+ removed --load-extension from branded Chrome, so an automated test cannot
// side-load the unpacked D-ASK extension the way a person does (chrome://extensions -> Load unpacked). This harness starts the REAL
// installed chrome.exe with a THROWAWAY profile (never the user's profile), installs the unpacked extension with the CDP command
// Extensions.loadUnpacked over Playwright's --remote-debugging-PIPE (no TCP port), then simply keeps Chrome running until stdin closes.
// Prints "READY <chromePid> <extensionId>" when the extension is installed, "FAIL <reason>" otherwise.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..", "extensions", "dask-chrome");
const chromeExe = process.argv[2] || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser;
try {
  browser = await chromium.launch({
    executablePath: chromeExe,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: ["--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check"],
  });
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: ext });
  const page = await (await browser.newContext()).newPage().catch(() => null);
  void page;
  const pid = browser.process?.()?.pid ?? 0;
  console.log(`READY ${pid} ${id}`);
} catch (e) {
  console.log(`FAIL ${String(e?.message ?? e).split("\n")[0]}`);
  try { await browser?.close(); } catch {}
  process.exit(1);
}
process.stdin.resume();
process.stdin.on("end", async () => { try { await browser.close(); } catch {} process.exit(0); });
