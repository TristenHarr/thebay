// Build the Preact /app SPA into dist/site/app (static assets served by the Worker).
// Run AFTER build-site (which wipes/recreates dist/site).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.cwd(), "dist/site/app");
mkdirSync(out, { recursive: true });

const result = await esbuild.build({
  entryPoints: [resolve(process.cwd(), "app/src/app.tsx")],
  bundle: true,
  format: "esm",
  splitting: true, // maplibre lazy-loads as its own chunk (only on the map view)
  jsx: "automatic",
  jsxImportSource: "preact",
  outdir: out,
  entryNames: "app",
  chunkNames: "chunk-[hash]",
  minify: true,
  sourcemap: false,
  target: "es2020",
  logLevel: "info",
  metafile: true,
});

cpSync(resolve(process.cwd(), "app/index.html"), resolve(out, "index.html"));
cpSync(resolve(process.cwd(), "app/app.css"), resolve(out, "app.css"));
cpSync(resolve(process.cwd(), "node_modules/maplibre-gl/dist/maplibre-gl.css"), resolve(out, "maplibre.css"));

const kb = (Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0) / 1024).toFixed(0);
console.log(`Built /app → dist/site/app  (${kb} KB)`);
