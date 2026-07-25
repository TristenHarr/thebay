# The Bay 🌉

**The founders × events social platform for the SF Bay Area — built entirely on Cloudflare.**

Discover every Bay Area tech event, show up with intent, and turn attendance into
relationships: goals, introductions, mentors, co-founders. Live at
**[thebay.events](https://thebay.events)** (classic dashboard) and
**[thebay.events/app](https://thebay.events/app)** (the social app).

[![CI](https://github.com/TristenHarr/thebay/actions/workflows/ci.yml/badge.svg)](https://github.com/TristenHarr/thebay/actions/workflows/ci.yml)
[![Deploy](https://github.com/TristenHarr/thebay/actions/workflows/deploy.yml/badge.svg)](https://github.com/TristenHarr/thebay/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

---

## What it does

- **Discover** — the world's-best faceted event filtering (date/time/category/free, live counts, trip planner) over thousands of scraped Bay Area events, plus an interactive **OSM map** with clickable pins.
- **Goals & achievements** — overall + per-event goals, points/streaks/trophies, shared publicly.
- **Show up** — QR check-in (host door screen + live roster), a mandatory **review-gate** (review your last event before registering for the next), photos & videos with **geo/time tagging**.
- **Connect** — friends, themed groups + **real-time chat** (Durable Objects), warm **intros on autopilot**, mentors & co-mentoring, **co-founder matching** (invite/save/skip/hide + filters), communities & rankings (super-connector, host NPS).
- **Reviews** — of events *and* hosts / speakers / participants, gated to people you actually met.
- **The Board** — a live map bulletin board (Yik-Yak-style notes), GPS-gated to the Bay.
- **Integrations** — import your Luma / Eventbrite / Meetup / Calendar (`.ics`) and LinkedIn (CSV); subscribe your agenda to any calendar; the itinerary links out to directions, transit, rideshare, parking & food.
- **AI** — event deep-research ("who's coming, who's VIP, what's in it for me") + a networking agent, powered by your own **OpenRouter key** or Workers AI, with a deterministic fallback.
- **PWA + native** — installable, offline shell, web push; a Capacitor wrap for iOS/Android.

## Tech stack

| Layer | Tech |
|---|---|
| Edge runtime | Cloudflare **Worker** (Hono) |
| Data | **D1** (SQLite) · **KV** (sessions) · **R2** (media) · **Durable Objects** (chat) |
| Web app | **React 18 + Vite + TypeScript + Tailwind + Redux Toolkit (RTK Query)** |
| Contract | **zod** schemas shared by client + server |
| Auth | Email + password (PBKDF2), Cloudflare Access-ready, OAuth-ready |
| Tests | **Vitest** (unit + HTTP-route integration) · **Playwright** (nav matrix + action journeys) |

## Quickstart

Everything runs locally with simulated Cloudflare bindings — **no account needed** to develop.

```bash
git clone https://github.com/TristenHarr/thebay
cd thebay
npm ci                       # installs deps + git guard-rail hooks
cp .dev.vars.example .dev.vars
npm run db:local             # apply D1 migrations to the local simulator
npm run build-web            # build the React app → dist/site/app

npm run dev                  # Worker + API + app at http://localhost:8787
```

Open **http://localhost:8787/app** and create an account (dev quick-login is offered on localhost). The classic dashboard is at **http://localhost:8787/**.

## Add a feature — the pit of success

```bash
npm run new:feature bookmark
```

Scaffolds a fully-wired, tested vertical slice (migration + repo + route + tests) and
**auto-registers** the route so it's mounted in the Worker *and* covered by the
integration-test harness. Then fill the generated `it.todo` red→green. See
**[ARCHITECTURE.md](./ARCHITECTURE.md)** for the map and conventions.

## Guard-rails

Quality is enforced, not hoped for:

- **`npm run verify`** — one command: typecheck (worker + web) + the full test suite. This is the gate.
- **Pre-push hook** (auto-installed on `npm install`) runs `verify` — you can't push red (`git push --no-verify` to override).
- **CI** ([`ci.yml`](./.github/workflows/ci.yml)) runs `verify` + builds on every push/PR.
- **CD** ([`deploy.yml`](./.github/workflows/deploy.yml)) deploys to Cloudflare on `main` **only after** the suite is green.
- **Invariants live in the schema** (FK / CHECK / UNIQUE); points, matches, and intros are server-authoritative — bad states are unrepresentable.
- **One route registry** (`src/worker/routes/index.ts`) is the single wiring point — add a route there and it's mounted *and* tested automatically.

```bash
npm run verify        # typecheck + all unit/integration tests
npm run test:nav      # Playwright: every screen renders, guards redirect   (needs `npm run dev`)
npm run test:actions  # Playwright: real multi-user journeys through the UI  (needs `npm run dev`)
npm run test:prod     # navigate the LIVE site as an agent over HTTP (safe subset)
```

`test:prod` (`tests/prod-e2e.mjs`) drives production through its JSON API — public
reads, security headers, the full auth lifecycle, self-scoped writes, per-community
rankings, people-you-may-know, and the negative gates. It's **safe against prod by
default** (no publicly-visible writes); `PROD_LIGHT=1` runs a zero-footprint
read-only smoke (used as a **post-deploy CI gate**), and `PROD_FULL=1` adds the
host→check-in→review journey. Point it anywhere with `BASE=…`.

## Data pipeline (the scraper)

The public-events catalog is produced by a **local scraper** (Eventbrite blocks
datacenter IPs, so it runs on a residential connection) that casts a wide net across
**Luma, Eventbrite, Partiful, Airtable, iCal, and arbitrary pages**, dedupes +
normalizes, tags/scores (Hardware / VC / Math / Software / …), then pushes into
production D1 via `POST /api/admin/ingest` (bearer-gated). Sources are fully editable
in `config/sources.json` / `config/cities.json`; the daily job is `scripts/daily-scrape.sh`.

```bash
npm run scrape        # scrape all enabled sources → local SQLite
npm run push          # push scraped events to production D1
npm run geocode       # backfill event coordinates (Photon/OSM)
```

## Deploy

CI deploys automatically on `main` once two repo secrets are set
(**Settings → Secrets and variables → Actions**): `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. For one-time provisioning (custom domain, secrets, Access,
VAPID, media) see **[DEPLOY.md](./DEPLOY.md)**. Full product spec:
**[PLATFORM_SPEC.md](./PLATFORM_SPEC.md)**.

## License

[MIT](./LICENSE) © Tristen Harr
