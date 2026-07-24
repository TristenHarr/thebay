import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchText } from "./util/http";
import { jsonLdRawEvents } from "./util/jsonld";

const HtmlParams = z.object({
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
  useBrowser: z.boolean().default(false),
  scroll: z.number().int().nonnegative().max(50).default(4),
});
type HtmlParams = z.infer<typeof HtmlParams>;

async function getHtml(
  url: string,
  useBrowser: boolean,
  scroll: number,
  ctx: AdapterContext,
): Promise<string> {
  if (!useBrowser) return fetchText(url, { headers: { accept: "text/html" } });
  return ctx.browser.withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);
    for (let s = 0; s < scroll; s++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(400);
    }
    return page.content();
  });
}

/**
 * Generic events page(s). Extracts schema.org JSON-LD `Event` markup (ubiquitous,
 * e.g. Meetup's city "find" pages). Set useBrowser=true for JS-rendered pages.
 */
export const htmlAdapter: SourceAdapter<HtmlParams> = {
  type: "html",
  parseParams(raw) {
    return HtmlParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    const p = cfg.params;
    const urls = p.urls?.length ? p.urls : p.url ? [p.url] : [];
    if (!urls.length) throw new Error("html source needs url or urls");

    const out: RawEvent[] = [];
    let failed = 0;
    for (const url of urls) {
      try {
        const html = await getHtml(url, p.useBrowser, p.scroll, ctx);
        out.push(...jsonLdRawEvents(html, cfg.id, "html"));
      } catch (err) {
        failed++;
        ctx.logger.warn(
          { source: cfg.id, url, err: (err as Error).message },
          "html page failed",
        );
      }
    }
    if (urls.length > 0 && failed === urls.length) {
      throw new Error(`all ${urls.length} html pages failed`);
    }
    ctx.logger.debug({ source: cfg.id, count: out.length }, "html extracted");
    return out;
  },
};
