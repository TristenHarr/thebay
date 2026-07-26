/**
 * Bundle the Chrome extension.
 *
 * The point of bundling rather than hand-writing the extension's JS is that it lets the
 * extension import `src/net/client.ts` and the pure JSON-LD mappers directly. Three clients
 * speaking one protocol only stays true if they literally share the code; a hand-maintained
 * copy of lease/submit/release would drift, and the client that drifted would look like a
 * bad actor rather than a bad build.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve("dist/extension");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: "extension/src/background.ts",
    popup: "extension/src/popup.ts",
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116", // MV3 service workers, `world: "MAIN"` scripting
  platform: "browser",
  // A service worker has no `process`; anything that reaches for it would throw on load.
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  minify: false, // reviewable source is worth more here than a few kilobytes
  sourcemap: true,
  logLevel: "info",
});

for (const f of ["manifest.json", "popup.html"]) copyFileSync(resolve("extension", f), resolve(out, f));

console.log(`extension → ${out}\nLoad it with chrome://extensions → Developer mode → Load unpacked.`);
