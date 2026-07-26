#!/usr/bin/env node
/**
 * Vendor the vector basemap's glyphs + sprite into web/public/map/.
 *
 * MapLibre needs SDF glyph PBFs to draw a single label, and it needs them from a
 * URL. Serving them from OUR origin under `/app/map/…` is not a detail: that path
 * is inside the service worker's `/app/` scope predicate (web/public/sw.js), so
 * labels are cached for offline use for free. A cross-origin font CDN is
 * uncacheable by that SW and would leave the offline map mute.
 *
 * `web/public/**` is copied verbatim by Vite into dist/site/app/, so everything
 * this writes lands at /app/map/… with no build wiring.
 *
 *   npm run build:map-assets          # skips what it already has
 *   npm run build:map-assets -- --force
 *
 * Source: protomaps/basemaps-assets (BSD-3 / OFL fonts), the same assets the
 * Protomaps reference styles use, so they match the schema our style targets.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const BASE = "https://protomaps.github.io/basemaps-assets";
const OUT = resolve(process.cwd(), "web/public/map");
const force = process.argv.includes("--force");

/** Latin + Latin-Extended-A covers every Bay Area street and place name we label. */
const FONT_STACKS = ["Noto Sans Regular", "Noto Sans Medium"];
const RANGES = ["0-255", "256-511"];
const SPRITES = [
  ["sprites/v4/dark.json", "sprite.json"],
  ["sprites/v4/dark.png", "sprite.png"],
  ["sprites/v4/dark@2x.png", "sprite@2x.png"],
];

const fmt = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
let fetched = 0, skipped = 0, failed = 0, bytes = 0;

async function grab(remote, local) {
  const dest = resolve(OUT, local);
  if (!force && existsSync(dest)) { skipped++; bytes += statSync(dest).size; return; }
  mkdirSync(dirname(dest), { recursive: true });
  const url = `${BASE}/${remote.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`  ✗ ${res.status} ${url}`); failed++; return; }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  bytes += buf.length;
  fetched++;
  console.log(`  ✓ ${local.padEnd(46)} ${fmt(buf.length)}`);
}

mkdirSync(OUT, { recursive: true });
console.log(`map assets → web/public/map (served at /app/map/, inside the SW scope)`);
for (const stack of FONT_STACKS) {
  for (const range of RANGES) await grab(`fonts/${stack}/${range}.pbf`, `fonts/${stack}/${range}.pbf`);
}
for (const [remote, local] of SPRITES) await grab(remote, local);

writeFileSync(resolve(OUT, "ATTRIBUTION.txt"), [
  "Glyphs: Noto Sans (SIL Open Font License 1.1) — SDF PBFs from protomaps/basemaps-assets.",
  "Sprite: protomaps/basemaps-assets sprites/v4 (BSD-3-Clause).",
  "Basemap data: © OpenStreetMap contributors (ODbL), tiled by Protomaps.",
  "",
  `Vendored by scripts/build-map-assets.mjs on ${new Date().toISOString()}.`,
].join("\n"));

console.log(`\n  ${fetched} fetched · ${skipped} already present · ${failed} failed · ${fmt(bytes)} total on disk`);
if (failed) process.exit(1);
