import type { Browser } from "playwright";
import { env } from "../../config/env";
import type { BrowserPool } from "../types";
import { DEFAULT_UA } from "./http";

/**
 * Lazily-launched shared Chromium. Playwright is imported dynamically so that
 * sources which never touch the browser tier don't pay for it, and a missing
 * browser install only breaks browser-tier sources (with a clear message).
 */
export function createBrowserPool(): BrowserPool {
  let browser: Browser | null = null;

  async function ensure(): Promise<Browser> {
    if (browser) return browser;
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error(
        "Playwright is not available. Run `npx playwright install chromium`.",
      );
    }
    try {
      browser = await chromium.launch({ headless: !env.BROWSER_HEADFUL });
    } catch (err) {
      throw new Error(
        `Failed to launch Chromium (run \`npx playwright install chromium\`): ${
          (err as Error).message
        }`,
      );
    }
    return browser;
  }

  return {
    async withPage(fn) {
      const b = await ensure();
      const context = await b.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
      });
      const page = await context.newPage();
      try {
        return await fn(page);
      } finally {
        await context.close();
      }
    },
    async close() {
      if (browser) {
        await browser.close();
        browser = null;
      }
    },
  };
}
