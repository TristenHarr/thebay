#!/usr/bin/env node
/**
 * Build the offline Bay vector basemap as a single PMTiles archive.
 *
 * There is no tile server here and no tilemaker run, and that is the point.
 * Protomaps publishes a DAILY planet build as one PMTiles file on R2, and the
 * `pmtiles extract` subcommand pulls an arbitrary bbox out of it over plain HTTP
 * range requests — it downloads only the tiles inside the box plus the directory
 * pages it needs to find them. A Bay-sized cut is minutes, not a rendering farm.
 *
 *   npm run build:pmtiles                 # yesterday's planet build, z0 → its max
 *   npm run build:pmtiles -- --maxzoom=14
 *   npm run build:pmtiles -- --date=20260720 --upload
 *
 * The bbox is `BAY_BOUNDS` from src/core/geo.ts — the SAME constant the geocoder
 * and the "is this in the Bay?" gate use, imported rather than retyped so the
 * map can never disagree with the catalog about where the Bay is.
 *
 * MEASUREMENT, NOT ESTIMATION: this script prints the real byte count of what it
 * produced. Every downstream decision (does it fit in OPFS on iOS? do we need a
 * z15 fallback?) is gated on that number, never on a guess.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BAY_BOUNDS } from "../src/core/geo.ts";
import { PMTILES_HEADER_BYTES, parsePmtilesHeader } from "../src/core/maps/pmtiles.ts";

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "data/packs");
/** Above this a pack will not install on a phone (iOS Safari's OPFS quota lands
 *  near 1 GB with real eviction) — emit a one-zoom-coarser sibling too. */
const PHONE_CEILING_BYTES = 1.5 * 1024 ** 3;
const PLANET = (date) => `https://build.protomaps.com/${date}.pmtiles`;

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);

const BBOX = [BAY_BOUNDS.minLng, BAY_BOUNDS.minLat, BAY_BOUNDS.maxLng, BAY_BOUNDS.maxLat].join(",");
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]} (${n.toLocaleString()} bytes)`;
};

function requirePmtiles() {
  const probe = spawnSync("pmtiles", ["--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) return (probe.stdout || probe.stderr).trim();
  console.error(`
✗ The \`pmtiles\` CLI is not on your PATH.

  It is a single Go binary (go-pmtiles) — install ONE of:

    macOS / Homebrew   brew install protomaps/tap/pmtiles
    Go toolchain       go install github.com/protomaps/go-pmtiles@latest
    Prebuilt release   https://github.com/protomaps/go-pmtiles/releases
                       (download the archive for your OS/arch, unpack, and put
                        the \`pmtiles\` binary somewhere on your PATH)

  Then re-run:  npm run build:pmtiles
`);
  process.exit(1);
}

/**
 * Read the SOURCE archive's own header with a 127-byte Range request. Asking for
 * --maxzoom=16 out of a planet build that stops at 15 silently produces a pack
 * that can't be overzoomed the way you expected, so clamp against the real
 * number instead of trusting a guess. (Measured: the daily build is z0–15.)
 */
async function planetHeader(url) {
  const res = await fetch(url, { headers: { range: `bytes=0-${PMTILES_HEADER_BYTES - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`planet header: HTTP ${res.status}`);
  return parsePmtilesHeader(await res.arrayBuffer());
}

/** Protomaps builds land daily; walk back until one exists (HEAD, no download). */
async function resolveBuildDate(explicit) {
  if (explicit) return explicit;
  for (let back = 1; back <= 10; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
    process.stdout.write(`  probing ${stamp}… `);
    try {
      const res = await fetch(PLANET(stamp), { method: "HEAD" });
      if (res.ok) {
        const size = Number(res.headers.get("content-length") || 0);
        console.log(`found (planet is ${size ? fmtBytes(size) : "unknown size"})`);
        return stamp;
      }
      console.log(`${res.status}`);
    } catch (e) {
      console.log(`unreachable (${e.message})`);
    }
  }
  console.error("✗ No Protomaps daily build found in the last 10 days. Pass --date=YYYYMMDD explicitly.");
  process.exit(1);
}

function extract(url, outPath, maxzoom) {
  const argv = ["extract", url, outPath, `--bbox=${BBOX}`, `--maxzoom=${maxzoom}`];
  console.log(`\n$ pmtiles ${argv.join(" ")}\n`);
  const t0 = Date.now();
  const r = spawnSync("pmtiles", argv, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ pmtiles extract failed (exit ${r.status}). Nothing was written to ${outPath}.`);
    process.exit(r.status || 1);
  }
  const bytes = statSync(outPath).size;
  console.log(`\n✓ ${outPath}\n  ${fmtBytes(bytes)}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return bytes;
}

function upload(file, id) {
  console.log(`\n$ wrangler r2 object put thebay-tiles/packs/${id} --file ${file} --remote`);
  execFileSync("npx", ["wrangler", "r2", "object", "put", `thebay-tiles/packs/${id}`, "--file", file, "--remote"], { stdio: "inherit" });
}

// --dry-run resolves the build, reads its header and reports the plan without
// downloading anything — the cheap way to confirm connectivity and the real
// zoom ceiling before committing to a multi-hundred-megabyte extract.
if (!args["dry-run"]) console.log(`pmtiles CLI: ${requirePmtiles()}`);
console.log(`bbox (BAY_BOUNDS): ${BBOX}`);
mkdirSync(OUT_DIR, { recursive: true });

const date = await resolveBuildDate(args.date);
const head = await planetHeader(PLANET(date));
console.log(`planet header: z${head.minZoom}–${head.maxZoom} · ${head.tileType}/${head.tileCompression} · ${head.addressedTiles.toLocaleString()} addressed tiles`);

const asked = Number(args.maxzoom || head.maxZoom);
const maxzoom = Math.min(asked, head.maxZoom);
if (asked > head.maxZoom) console.log(`⚠ --maxzoom=${asked} clamped to the planet build's own max of z${head.maxZoom}.`);

const built = [];
const idFor = (z) => `bay-z${z}-${date}.pmtiles`;

if (args["dry-run"]) {
  console.log(`\n── plan (dry run — nothing downloaded) ─────────────────────────`);
  console.log(`  source : ${PLANET(date)}`);
  console.log(`  extract: pmtiles extract <source> ${idFor(maxzoom)} --bbox=${BBOX} --maxzoom=${maxzoom}`);
  console.log(`  output : data/packs/${idFor(maxzoom)}`);
  console.log(`  size   : UNKNOWN until the extract runs — this script prints the measured bytes, it never estimates.`);
  console.log("────────────────────────────────────────────────────────────────");
  process.exit(0);
}

const mainPath = resolve(OUT_DIR, idFor(maxzoom));
built.push({ id: idFor(maxzoom), path: mainPath, maxzoom, bytes: extract(PLANET(date), mainPath, maxzoom) });

// The size gate is MEASURED, not predicted. A pack over ~1.5 GB will not install
// on iOS Safari (see web/src/offline/opfs.ts — the origin quota is around 1 GB
// with real eviction), so ship a coarser sibling the phone CAN hold.
if (built[0].bytes > PHONE_CEILING_BYTES && maxzoom > 12) {
  const fallback = maxzoom - 1;
  console.log(`\n⚠ z${maxzoom} measured ${fmtBytes(built[0].bytes)} — over the ${fmtBytes(PHONE_CEILING_BYTES)} phone ceiling. Building a z${fallback} fallback.`);
  const fbPath = resolve(OUT_DIR, idFor(fallback));
  built.push({ id: idFor(fallback), path: fbPath, maxzoom: fallback, bytes: extract(PLANET(date), fbPath, fallback) });
}

const manifest = {
  builtAt: new Date().toISOString(),
  planet: PLANET(date),
  bbox: { minLng: BAY_BOUNDS.minLng, minLat: BAY_BOUNDS.minLat, maxLng: BAY_BOUNDS.maxLng, maxLat: BAY_BOUNDS.maxLat },
  packs: built.map(({ id, maxzoom: mz, bytes }) => ({ id, maxzoom: mz, bytes })),
};
writeFileSync(resolve(OUT_DIR, "pmtiles-manifest.json"), JSON.stringify(manifest, null, 2));

console.log("\n── measured output ─────────────────────────────────────────────");
for (const b of built) console.log(`  ${b.id.padEnd(34)} z0–${b.maxzoom}  ${fmtBytes(b.bytes)}`);
console.log("────────────────────────────────────────────────────────────────");

if (args.upload) {
  for (const b of built) upload(b.path, b.id);
  console.log("\n✓ uploaded. GET /api/maps/packs now reports these real sizes.");
} else {
  console.log("\nTo publish (R2 has zero egress, which is why this is affordable):");
  for (const b of built) console.log(`  npx wrangler r2 object put thebay-tiles/packs/${b.id} --file ${b.path} --remote`);
  console.log("  …or re-run with --upload");
}
