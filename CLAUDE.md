# CLAUDE.md — working in this repo

Operational quick-reference for AI agents and contributors. For the full map read
**[ARCHITECTURE.md](./ARCHITECTURE.md)**; for the contributor loop, **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## What this is

**The Bay** — a founders × events platform for the SF Bay Area, on Cloudflare. Two
Workers in one repo (see ARCHITECTURE.md → "Two sites, one repo"):

- **thebay.events** — the events app + API + social platform. Worker entry `src/worker/index.ts`; React app in `web/`; static dashboard built by the CLI.
- **thebay.news** — a server-rendered Bay-native news site. Config `wrangler.news.jsonc`.

The public events catalog is produced by a **local scraper** (Eventbrite blocks
datacenter IPs) that pushes into production D1 over an authenticated ingest endpoint.

## The one rule: `npm run verify` is the gate

```bash
npm run verify   # tsc (worker) + tsc (web) + all vitest — MUST pass before every push
```

The pre-push hook runs it. Never push red. **TDD is the norm** — write the failing
test first, then the code. Every bug fix starts with a test that reproduces it.

## Golden path when adding a backend feature

1. `npm run new:feature <name>` — scaffolds migration + repo + route + tests, and
   **auto-registers** the route in `src/worker/routes/index.ts` (mounted in the Worker
   *and* covered by the integration harness — no manual wiring, no drift).
2. `npm run db:local` to apply the migration; fill the generated `it.todo` red→green.
3. Types are the contract: shapes live in `shared/schema.ts` (zod), shared by client + server.

## Conventions (non-negotiable)

- **Invariants live in the SQL schema** (FK / CHECK / UNIQUE) — make bad states unrepresentable, don't validate in handlers.
- **Repos are thin** (`src/storage/d1/*-repo.ts`); routes are thin (`src/worker/routes/*.ts`); logic is pure and lives in `src/core`, `src/ai`, `src/integrations`.
- **All web server-state through RTK Query** (`web/src/api.ts`) — no hand-rolled `fetch` in components; invalidate cache tags.
- Naming: repo `XRepo`, route factory `xRoutes`, endpoint `/api/<plural>`, hook `useGetX*`.
- Every user-facing screen has a `data-testid` + a nav-matrix entry.

## The scraper pipeline (local → prod)

`sources → normalize → dedup → tag → store (local SQLite) → push (D1)`. Config in
`config/sources.json` + `config/cities.json` + `config/categories.json`.

```bash
npm run scrape    # all enabled sources → local SQLite (records a run)
npm run tag       # (re)tag pending events with the keyword tagger
npm run push      # INGEST_TOKEN=… INGEST_URL=https://thebay.events npm run push
npm run geocode   # backfill coordinates
npm run schedule:install   # macOS launchd: run daily at 08:00 (schedule:status/:uninstall)
```

Observability: `GET /api/scrape-status` (public — last run, totals, `stale` flag) and
`GET /api/runs`. Every `push` records a run via `POST /api/admin/scrape-report`.

## Admin endpoints (all bearer-gated with `INGEST_TOKEN`)

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/ingest` | the scraper pushes canonical events |
| `POST /api/admin/scrape-report` | record a run for `/api/scrape-status` |
| `POST /api/admin/renormalize` | re-resolve city + fingerprint in place, dedup (run after `cities.json` changes) |
| `POST /api/admin/prune-out-of-region` | drop confidently non-Bay events |
| `POST /api/admin/retag` | re-tag whole catalog, REPLACING categories (run after the tagger changes) |
| `POST /api/admin/run-autopilot` | warm-intros autopilot (also on a cron) |
| `POST /api/admin/geocode` | backfill coordinates |

## Gotchas that will bite you

- **Build order:** `build-site` does `rmSync(dist/site)`, so it MUST run before
  `build-web` (which writes `dist/site/app`) or `/app` is wiped → serves the dashboard shell.
- **Dedup fingerprint = `hash(normalizeTitle | localDay | city)`** and `events.fingerprint`
  is NOT unique. Changing `cities.json` re-resolves the embedded city → new fingerprint →
  the next scrape would re-insert as a **duplicate**. Fix stored rows with `renormalize` FIRST.
- **Ingest `mergeEvents` UNIONS categories** — a push can add a tag but never remove a stale
  one. To correct tags across the catalog, run `retag` (it REPLACES).
- **Tagger matches on word boundaries**, not substrings (else `ai`⊂"email", `vc`⊂"service").
- **`@cloudflare/workers-types` are NOT ambient** (tsconfig `types: ["node"]`) — import
  `D1Database` / `ScheduledController` / etc. explicitly.
- Worker default export is `{ fetch, scheduled }` (cron), not a bare Hono app — tests call `app.fetch`.

## Testing tiers (see ARCHITECTURE.md → "Testing strategy")

- **Unit** — pure logic (`core`, `ai`, `integrations`) + repos over the D1-over-SQLite shim (`tests/helpers`).
- **HTTP integration** — the real Hono app via `tests/helpers/app.ts` (`makeTestApp`, `call`, `login`); every registered route is auto-covered.
- **Playwright** — `npm run test:nav` (every screen renders/guards) + `npm run test:actions` (multi-user journeys); need `npm run dev`.
- **Production e2e** — `npm run test:prod` navigates the LIVE site as an agent; `PROD_LIGHT=1` is a zero-footprint post-deploy CI gate; `PROD_FULL=1` adds destructive journeys.

## Deploy

Push to `main` → CI runs `verify` → deploys both Workers → post-deploy smoke gates.
Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. See **[DEPLOY.md](./DEPLOY.md)**.
For one-off local deploys use `npm run deploy` (never bundle uncommitted WIP).
