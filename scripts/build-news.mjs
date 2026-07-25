#!/usr/bin/env node
/**
 * Build thebay.news static assets.
 *
 * There is no bundler here and that is the point: the news site is server-rendered
 * HTML plus one hand-written stylesheet and one progressive-enhancement script.
 * This copies them, content-hashes them so they can be cached immutably, and
 * writes the manifest the Worker reads to know their names.
 *
 * Output goes to dist/news — a SEPARATE tree from dist/site, so the events build's
 * rmSync(dist/site) can never touch it and the two can be built in any order.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src/server/news-public");
const OUT = resolve(ROOT, "dist/news");

const hash8 = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 8);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(resolve(OUT, "assets"), { recursive: true });

// Everything that isn't hashed (icon, any images) is copied verbatim.
for (const f of readdirSync(SRC)) {
  if (f === "news.css" || f === "news.js") continue;
  cpSync(resolve(SRC, f), resolve(OUT, f), { recursive: true });
}

// Content-hash the two files that change: immutable caching, no stale-asset risk.
const manifest = {};
for (const [name, key] of [["news.css", "css"], ["news.js", "js"]]) {
  const buf = readFileSync(resolve(SRC, name));
  const [base, ext] = [name.replace(/\.[^.]+$/, ""), name.split(".").pop()];
  const hashed = `${base}.${hash8(buf)}.${ext}`;
  writeFileSync(resolve(OUT, "assets", hashed), buf);
  // Also emit the unhashed name so a cold Worker with no manifest still works.
  writeFileSync(resolve(OUT, name), buf);
  manifest[key] = `/assets/${hashed}`;
}
writeFileSync(resolve(OUT, "asset-manifest.json"), JSON.stringify(manifest, null, 2));

// The asset layer serves these directly, so they need their own headers — the
// Worker's harden() only covers responses the Worker itself produces.
writeFileSync(
  resolve(OUT, "_headers"),
  `# thebay.news static assets. HTML is rendered by the Worker and hardened there;
# these rules cover what the asset layer serves on its own.
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/news.css
  Cache-Control: public, max-age=300

/news.js
  Cache-Control: public, max-age=300

/icon.svg
  Cache-Control: public, max-age=86400

/asset-manifest.json
  Cache-Control: public, max-age=60
`,
);

console.log(`built dist/news → ${manifest.css}, ${manifest.js}`);
