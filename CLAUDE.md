# CLAUDE.md — working in this repo

Operational quick-reference for AI agents and contributors. For the full map read
**[ARCHITECTURE.md](./ARCHITECTURE.md)**; for the contributor loop, **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## What this is

**The Bay** — a founders × events platform for the SF Bay Area, on Cloudflare. Two
Workers in one repo (see ARCHITECTURE.md → "Two sites, one repo"):

- **thebay.events** — the events app + API + social platform. Worker entry `src/worker/index.ts`; React app in `web/`; static dashboard built by the CLI.
- **thebay.news** — a server-rendered Bay-native news site. Config `wrangler.news.jsonc`.

The public events catalog is produced two ways. The original: a **local scraper** (Eventbrite
blocks datacenter IPs) pushing into production D1 over an authenticated ingest endpoint. The
new one: a **distributed scrape network** of members running the same scrapers from their own
machines and browsers, whose results are cross-checked before anything publishes — see
"The scrape network" below.

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

## The scrape network (distributed → prod)

Members scrape on the catalog's behalf; the coordinator decides who scrapes what, how often,
and whether to believe them. Migrations `0023` (identity) + `0025` (work queue) + `0029` (audits).

```bash
npm run work              # BAY_WORKER_TOKEN=… npm run work -- --url https://thebay.events
npm run build:extension   # Chrome extension → dist/extension (Load unpacked)
curl /api/net/status      # is the network alive? (see DEPLOY.md § 4b)
```

**Requires two secrets or it is completely inert:** `HANDSHAKE_KEY` (joining 503s without it)
and `ADMIN_HANDLES` (founding members — without one, nobody can ever be admitted).

The five things to understand before changing any of it:

1. **Volunteers submit `RawEvent[]`; the server derives canon.** `/api/net/submit` normalizes,
   fingerprints and dedups with `src/core/**`. A client cannot choose which existing event its
   data merges into, because it never computes the key. (Contrast `/api/admin/ingest`, which
   trusts a client-supplied `fingerprint` — fine for the operator's own machine, not for anyone
   else.)
2. **Politeness is a lease policy, not a client-side sleep.** `HOST_MIN_GAP_MS` is an in-memory
   Map and does not survive distribution, so the coordinator withholds work instead. The gap is
   enforced by an atomic conditional `UPDATE` on `scrape_hosts` — D1 has no `SELECT … FOR
   UPDATE`, so reading-then-deciding would let two workers both be handed the same host.
   robots.txt is fetched by cron (`src/worker/net-tick.ts`) and enforced at lease time.
3. **Independence is measured by egress, not by account.** Two accounts behind one NAT are one
   observer; their agreement is not consensus.
4. **You are never punished for being alone.** `pending` costs nothing. Only a *contradiction*
   — an independent worker with a demonstrably overlapping view who didn't see it — moves
   reputation, and a later confirmation refunds it. Standing is RECOMPUTED from observations, so
   refunds are free.
5. **Scrapers improve as data, never as shipped code.** A recipe is `{ type, params }` for an
   adapter already in `src/sources/registry.ts`, validated by that adapter's own `parseParams`.
   Candidates run in shadow beside the incumbent and are promoted only by
   `src/core/scrape/audit.ts`. Every verdict is logged in `recipe_audits` and reversible.

Entry is an **in-person handshake**: the ambassador's phone plays an HMAC-derived code at 400ms
and the joiner must capture four consecutive frames (`src/core/net/handshake.ts`). No secret is
stored server-side. That gate is the anti-Sybil primitive; consensus is the second layer.

## Admin endpoints (all bearer-gated with `INGEST_TOKEN`)

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/ingest` | the scraper pushes canonical events |
| `POST /api/admin/scrape-report` | record a run for `/api/scrape-status` |
| `POST /api/admin/renormalize` | re-resolve city + fingerprint in place, dedup (run after `cities.json` changes) |
| `POST /api/admin/prune-out-of-region` | drop confidently non-Bay events |
| `POST /api/admin/retag` | legacy: re-tag whole catalog, REPLACING `categories`. **Superseded by `enrich`** — unbounded (`SELECT *` over every event) and writes only the legacy column |
| `POST /api/admin/enrich?limit=&cursor=&force=&llm=0` | **the tagging job.** Bounded + resumable: tags one id-cursor slice into `event_tags` (model → `KeywordTagger` fallback), write-throughs `events.categories`, and embeds into Vectorize when bound. Loop on `nextCursor` until `scanned` is 0 |
| `POST /api/admin/reindex?limit=&cursor=&force=` | backfill/repair `events_fts` (triggers keep it in sync for live writes; this is for pre-migration rows) |
| `POST /api/admin/tags` | add/edit `tag_vocab` rows — a new tag is a row, not a redeploy |
| `POST /api/admin/run-autopilot` | warm-intros autopilot (also on a cron) |
| `POST /api/admin/geocode` | backfill coordinates |

The check itself lives in **one** place: `requireIngestToken` / `ingestTokenOk` in
`src/worker/middleware/bearer.ts`. It was copy-pasted thirteen times with a non-constant-time
`!==`; `tests/net-guards.test.ts` fails if a fourteenth copy appears. Volunteers never get this
token — they get a per-device worker token scoped to `/api/net/*`
(`src/worker/middleware/worker-token.ts`).

## Gotchas that will bite you

- **Build order:** `build-site` does `rmSync(dist/site)`, so it MUST run before
  `build-web` (which writes `dist/site/app`) or `/app` is wiped → serves the dashboard shell.
- **Dedup fingerprint = `hash(normalizeTitle | localDay | city)`** and `events.fingerprint`
  is NOT unique. Changing `cities.json` re-resolves the embedded city → new fingerprint →
  the next scrape would re-insert as a **duplicate**. Fix stored rows with `renormalize` FIRST.
- **Ingest `mergeEvents` UNIONS categories** — a push can add a tag but never remove a stale
  one. To correct tags across the catalog, run `enrich` (it REPLACES machine tags).
- **Tagger matches on word boundaries**, not substrings (else `ai`⊂"email", `vc`⊂"service").
- **`events.categories` is now DERIVED.** The truth is `event_tags` + `tag_vocab`
  (migration 0014); `SearchRepo` write-throughs the JSON column from the `topic:` facet
  because `/api/events`, the static dashboard and `src/news/curate.ts` still read it.
  Write tags through `SearchRepo`, never `UPDATE events SET categories` directly — and
  note `retag` does exactly that, which is why `enrich` replaces it.
- **`event_tags.source` is provenance, not decoration.** `enrich` deletes and rewrites
  `'keyword'`/`'llm'` rows and must never touch `'host'`/`'crowd'` — a human's label
  cannot be recomputed.
- **`events_fts` is kept in sync by SQL triggers** (0014), not by application discipline,
  so any writer leaves it correct. `body` includes tag labels, so changing an event's tags
  re-indexes it. Rank with `bm25(events_fts, 8.0, 1.0)`; never pass user text into `MATCH`
  (it's a query language — use `core/search/fts.ts`).
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
