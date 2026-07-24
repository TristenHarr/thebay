#!/usr/bin/env node
/**
 * Feature scaffolder — the pit of success made executable.
 *
 *   npm run new:feature <name>        e.g.  npm run new:feature bookmark
 *
 * Stamps a complete, wired, test-covered vertical slice:
 *   • migrations/NNNN_<name>.sql   — table with FK/CHECK/UNIQUE invariants
 *   • src/storage/d1/<name>-repo.ts — repo class (data access)
 *   • src/worker/routes/<name>.ts   — Hono route factory
 *   • tests/<name>.test.ts          — repo + HTTP-route tests (green scaffold + it.todo checklist)
 * …and AUTO-WIRES the route into src/worker/routes/index.ts, so it is instantly
 * mounted in the Worker AND covered by the integration harness. Then: red→green.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = (process.argv[2] || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!raw) { console.error("usage: npm run new:feature <name>   (e.g. bookmark)"); process.exit(1); }

const kebab = raw;                                   // bookmark  /  saved-search
const camel = kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()); // bookmark / savedSearch
const Pascal = camel[0].toUpperCase() + camel.slice(1);                 // Bookmark / SavedSearch
const table = camel.replace(/([A-Z])/g, "_$1").toLowerCase() + "s";     // bookmarks / saved_searchs (rename in the migration if the plural is odd)
const factory = `${camel}Routes`;
const RepoClass = `${Pascal}Repo`;

const write = (rel, content) => {
  const p = resolve(ROOT, rel);
  if (existsSync(p)) { console.error(`✗ refusing to overwrite existing ${rel}`); process.exit(1); }
  writeFileSync(p, content);
  console.log(`  + ${rel}`);
};

// ── migration ────────────────────────────────────────────────────────────────
const nums = readdirSync(resolve(ROOT, "migrations")).map((f) => parseInt(f.slice(0, 4), 10)).filter((n) => !Number.isNaN(n));
const next = String(Math.max(0, ...nums) + 1).padStart(4, "0");
write(`migrations/${next}_${kebab}.sql`, `-- ${kebab} feature (generated). Push invariants into the schema (FK / CHECK / UNIQUE)
-- so bad states are unrepresentable — that's the pit of success.
CREATE TABLE IF NOT EXISTS ${table} (
  id         TEXT PRIMARY KEY,               -- ULID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id);
`);

// ── repo ─────────────────────────────────────────────────────────────────────
write(`src/storage/d1/${kebab}-repo.ts`, `import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";

type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/** ${RepoClass} — data access for the ${kebab} feature. All invariants live in the
 *  migration; this layer is thin, async, and positional-bind only. */
export class ${RepoClass} {
  constructor(private db: D1Database) {}

  async list(userId: string): Promise<Row[]> {
    const r = await this.db.prepare("SELECT * FROM ${table} WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<Row>();
    return r.results ?? [];
  }

  async create(userId: string, name: string): Promise<string> {
    const id = ulid();
    await this.db.prepare("INSERT INTO ${table} (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, userId, name, nowIso()).run();
    return id;
  }
}
`);

// ── route ────────────────────────────────────────────────────────────────────
write(`src/worker/routes/${kebab}.ts`, `import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { ${RepoClass} } from "../../storage/d1/${kebab}-repo";
import { requireAuth } from "../../auth/middleware";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new ${RepoClass}(c.env.DB);

export function ${factory}(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  app.get("/api/${table}", requireAuth, async (c) => c.json({ ${table}: await repo(c).list(c.get("user")!.id) }));

  app.post("/api/${table}", requireAuth, async (c) => {
    const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!name) return c.json({ error: "name required" }, 400);
    return c.json({ ok: true, id: await repo(c).create(c.get("user")!.id, name) });
  });

  return app;
}
`);

// ── test (green scaffold + TODO checklist) ─────────────────────────────────────
write(`tests/${kebab}.test.ts`, `import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { makeTestApp, call, login } from "./helpers/app";
import { ${RepoClass} } from "../src/storage/d1/${kebab}-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

describe("${RepoClass}", () => {
  let d1: any, repo: ${RepoClass}, social: SocialRepo;
  beforeEach(() => { ({ d1 } = makeTestDb()); repo = new ${RepoClass}(d1); social = new SocialRepo(d1); });

  it("creates and lists per user", async () => {
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    const id = await repo.create(u.id, "First");
    expect((await repo.list(u.id)).map((x) => x.id)).toContain(id);
  });

  it.todo("enforce this feature's real invariants (write these BEFORE the code)");
});

describe("/api/${table} routes", () => {
  it("requires auth and round-trips create → list", async () => {
    const t = makeTestApp(); // route is auto-mounted via the registry — no wiring needed
    expect((await call(t, "/api/${table}")).status).toBe(401);
    const { cookie } = await login(t, "a@x.com", "Ann");
    expect((await call(t, "/api/${table}", { method: "POST", cookie, body: {} })).status).toBe(400);
    const created = await call(t, "/api/${table}", { method: "POST", cookie, body: { name: "Hello" } });
    expect(created.status).toBe(200);
    const listed = await call(t, "/api/${table}", { cookie });
    expect(listed.json.${table}.some((x: any) => x.id === created.json.id)).toBe(true);
  });
});
`);

// ── auto-wire into the route registry ─────────────────────────────────────────
const regPath = resolve(ROOT, "src/worker/routes/index.ts");
let reg = readFileSync(regPath, "utf8");
reg = reg.replace("// gen:imports", `import { ${factory} } from "./${kebab}";\n// gen:imports`);
reg = reg.replace("  // gen:registry", `  ${factory},\n  // gen:registry`);
writeFileSync(regPath, reg);
console.log(`  ~ src/worker/routes/index.ts (auto-mounted + auto-tested)`);

console.log(`\n✓ Scaffolded "${kebab}". Next:
  1. npx wrangler d1 migrations apply thebay-db --local   # apply ${next}_${kebab}.sql
  2. npm test -- ${kebab}                                  # watch the scaffold pass, fill the it.todo (red→green)
  3. Frontend (3 lines): add an endpoint in web/src/api.ts, a component in
     web/src/features/${kebab}/, and a <Route> in web/src/app/App.tsx.
  See ARCHITECTURE.md → "Add a feature".`);
