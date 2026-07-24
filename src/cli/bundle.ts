import { parseArgs } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRepository } from "../storage";
import { loadCategories } from "../config/load";

const PUBLIC = resolve(process.cwd(), "src/server/public");

/** Build a fully self-contained, embeddable single HTML file (data + CSS + JS
 *  inlined). Drop it in an iframe anywhere — no server, no external requests. */
export async function bundleCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      "site-url": { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  const out = resolve(process.cwd(), (values.out as string) || "dist/eventers-embed.html");

  const repo = createRepository();
  let events;
  try {
    const res = await repo.queryEvents({
      from: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      limit: values.limit ? Number(values.limit) : 1000,
      sort: "start",
    });
    events = res.events;
  } finally {
    repo.close();
  }

  const categories = loadCategories().map((c) => ({ id: c.id, label: c.label, color: c.color }));
  const data = {
    events,
    categories,
    updatedAt: new Date().toISOString(),
    siteUrl: (values["site-url"] as string) || undefined,
  };

  // Make the JSON safe to embed inside a <script>: escape </script> and the JS
  // line-terminator chars U+2028/U+2029 (kept as char codes to avoid literal
  // separators in this source file).
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const safeJson = JSON.stringify(data)
    .replace(/<\//g, "<\\/")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");

  const html = readFileSync(resolve(PUBLIC, "embed.html"), "utf8");
  const js = readFileSync(resolve(PUBLIC, "embed.js"), "utf8");

  const bundled = html
    .replace(
      "<!--EVENTERS_DATA-->",
      `<script>window.__EVENTERS__ = ${safeJson};</script>`,
    )
    .replace('<script src="/embed.js"></script>', `<script>${js}</script>`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bundled);
  const kb = Math.round(bundled.length / 1024);
  console.log(`Built self-contained embed bundle: ${out} (${events.length} events, ${kb} KB)`);
  console.log(`Embed:  <iframe src=".../eventers-embed.html" style="width:100%;height:640px;border:0"></iframe>`);
}
