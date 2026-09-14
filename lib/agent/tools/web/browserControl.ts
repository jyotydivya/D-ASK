import { chromium, Browser, BrowserContext, Page } from "playwright";

/**
 * Service to manage Playwright browser automation for D-ASK.
 */
export class BrowserControlService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async ensureBrowser(): Promise<Page> {
    if (!this.browser) {
      // Launch in headful mode so the user can see what the agent is doing
      this.browser = await chromium.launch({ headless: false });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  /**
   * Navigate to a URL.
   */
  async navigate(url: string): Promise<void> {
    const page = await this.ensureBrowser();
    // Prepend https:// if protocol is missing
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  /**
   * Click an element by CSS selector or text.
   */
  async click(selector: string): Promise<void> {
    const page = await this.ensureBrowser();
    // Playwright supports text selectors natively like "text=Login"
    await page.click(selector, { timeout: 10000 });
  }

  /**
   * Type text into an element.
   */
  async type(selector: string, text: string): Promise<void> {
    const page = await this.ensureBrowser();
    await page.fill(selector, text, { timeout: 10000 });
  }

  /**
   * Press a specific key (e.g. "Enter").
   */
  async press(selector: string, key: string): Promise<void> {
    const page = await this.ensureBrowser();
    await page.press(selector, key, { timeout: 10000 });
  }

  /**
   * Take a screenshot of the current page.
   * Returns a Base64-encoded string.
   */
  async takeScreenshot(): Promise<string> {
    const page = await this.ensureBrowser();
    const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
    return buffer.toString("base64");
  }

  /**
   * Get the current page's HTML structure or text.
   */
  async getPageText(): Promise<string> {
    const page = await this.ensureBrowser();
    // Return visible text
    const text = await page.evaluate(() => document.body.innerText);
    return text;
  }

  /**
   * Close the browser.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

export const browserControlService = new BrowserControlService();
