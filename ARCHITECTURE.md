# Architecture — The Bay

> How this codebase is organized and how to add to it. The guiding principle is
> the **pit of success**: the easy way is the correct way. Invariants live in the
> schema, routes auto-wire, tests auto-cover, and a generator stamps the whole
> vertical slice for you. If you're fighting the structure, you're holding it wrong.

## The stack (what runs where)

| Layer | Tech | Lives in |
|-------|------|----------|
| Edge runtime | Cloudflare **Worker** (Hono) | `src/worker/` |
| Relational data | **D1** (SQLite) | `migrations/*.sql`, `src/storage/d1/` |
| Sessions / OAuth state | **KV** | `src/auth/` |
| Photos / avatars | **R2** | `src/worker/routes/media.ts`, `social.ts` |
| Real-time chat | **Durable Objects** | `src/realtime/` |
| Media transcode | Cloudflare **Images / Stream** | `src/worker/routes/media.ts` |
| Login | Cloudflare **Access** (email OTP) | `src/auth/access.ts` |
| Optional AI phrasing | **Workers AI** | `src/ai/`, `src/worker/routes/ai.ts` |
| Web app | **React + Vite + TS + Tailwind + Redux Toolkit** | `web/` |
| Contract | **zod** schemas shared by both sides | `shared/schema.ts` |

The classic static dashboard + free public API + `/embed` widget still serve unchanged; the React app lives at `/app`.

## The golden path of a request

Data flows through the same layers every time. Adding a feature means touching each once, in order:

```
shared/schema.ts        zod types = the contract (validate at the boundary)
   ↓
src/storage/d1/*-repo.ts   repo: the ONLY place that talks to D1. Thin, async, positional binds.
   ↓
src/worker/routes/*.ts     route: Hono handler. Parse → authorize → call repo → json.
   ↓
src/worker/routes/index.ts registry: one array. Auto-mounts in the Worker AND the test harness.
   ↓
web/src/api.ts             RTK Query endpoint: the single typed server-state layer (no hand fetch).
   ↓
web/src/features/<x>/      the screen. Reads/writes only through RTK Query hooks.
   ↓
web/src/app/App.tsx        one <Route> wires it into navigation.
```

**There is exactly one place to wire a route** — `src/worker/routes/index.ts`. `src/worker/index.ts` and `tests/helpers/app.ts` both iterate that registry, so a new route is mounted in production and covered by integration tests with no extra wiring. That's the anti-drift guarantee.

## Directory map

```
migrations/            0001_init → 0003_push. Ordered, additive. Schema = invariants.
shared/schema.ts       zod: User, Goal, Review, Intro, POINTS economy, request bodies…
src/
  worker/
    index.ts           the Hono app: public events API, geocode admin, onError, SPA fallback
    routes/index.ts    ← the route registry (single source of truth)
    routes/*.ts        one file per domain: social, platform, graph, integrations, media, ai, push
    env.ts             every binding + secret (all optional so it boots un-configured)
  storage/d1/          one repo per aggregate; barrel at index.ts
  auth/                session (KV), middleware (requireAuth/optionalAuth), oauth, access, magic
  ai/, integrations/, core/, push/   pure, unit-tested logic (no I/O)
  realtime/            Durable Object chat
web/src/
  api.ts               RTK Query — ~60 endpoints, the typed server-state layer
  store.ts             Redux store
  ui/kit.tsx           the component kit (Button, Card, Chip, Skeleton…) + CommandPalette
  features/<x>/        feature-folders; each screen is self-contained
  app/App.tsx          routes + nav + guards
tests/
  helpers/d1.ts        D1-over-better-sqlite3 shim (loads ALL migrations, real FK/CHECK/UNIQUE)
  helpers/app.ts       HTTP harness: mounts the route registry, login()/call() helpers
  *.test.ts            repo unit tests + HTTP route integration tests
  nav-matrix.mjs       Playwright: every screen renders, guards redirect, golden paths work
scripts/new-feature.mjs  the generator
```

## Invariants — pushed down so bad states can't exist

- **Schema is law.** FK `ON DELETE CASCADE`, `CHECK` on enums, `UNIQUE` on natural keys. A wrong write is rejected by D1, not by a hopeful `if`.
- **Points are idempotent.** `points_ledger` has a `UNIQUE dedup_key`; awards use a stable key (`checkin:<user>:<event>`), so re-runs never double-count. Never use a random key.
- **The review-gate** is enforced in `social.ts` RSVP + `platform.ts` review: you must review your last attended event before registering for the next; reviewing requires attendance.
- **Auth is explicit.** `requireAuth` for anything user-scoped; owner/host actions re-check ownership in the handler. `optionalAuth` only for public reads that adapt to the viewer.
- **Errors don't leak.** `app.onError` maps DB constraint violations to `409`, everything else to a clean `500` — no stack traces to clients.
- **Money-shaped things are server-authoritative** (points, matches, intros). The client never asserts them.

## Testing strategy (TDD, three tiers)

1. **Repo unit tests** (`tests/*-repo.test.ts`) — real SQLite via the shim, real constraints. Test the rules: streak math, review-gate, mutual-friend counts, idempotency.
2. **HTTP route integration tests** (`tests/routes.test.ts` + the harness) — exercise real Hono handlers end-to-end: auth guards, status codes, response shapes, security. Catches what repo tests can't (handler logic, authz).
3. **Playwright nav matrix** (`tests/nav-matrix.mjs`) — every route renders with no page errors, guards redirect, golden journeys (RSVP, ⌘K, map pins, filtering) work.

Pure logic (`src/ai`, `src/integrations`, `src/core`, `src/push`) is unit-tested directly with fixed inputs (e.g. a fixed clock for date filters). **Write the test first** — the generator gives you a red `it.todo` to fill.

## Add a feature — the recipe

```bash
npm run new:feature bookmark
```

This stamps and **auto-wires**: a migration (`NNNN_bookmark.sql`), a repo (`BookmarkRepo`), a route (`bookmarkRoutes`, added to the registry), and a test file (repo + HTTP tests, already green, with an `it.todo` checklist). Then:

```bash
npx wrangler d1 migrations apply thebay-db --local   # apply the new table
npm test -- bookmark                                  # green scaffold; now write the it.todo tests red→green
```

Frontend is three lines (documented; kept manual because it's obvious and editing generated TS is fragile):

1. **Endpoint** in `web/src/api.ts`:
   ```ts
   getBookmarks: b.query<{ bookmarks: any[] }, void>({ query: () => "api/bookmarks", providesTags: ["Bookmarks"] }),
   createBookmark: b.mutation<any, { name: string }>({ query: (body) => ({ url: "api/bookmarks", method: "POST", body }), invalidatesTags: ["Bookmarks"] }),
   ```
   (add `"Bookmarks"` to `tagTypes`, export the hooks at the bottom.)
2. **Component** in `web/src/features/bookmark/Bookmark.tsx` — use the kit (`Card`, `Button`, `PageHeader`, `EmptyState`) and only the RTK hooks. Give the root a `data-testid`.
3. **Route** in `web/src/app/App.tsx`: `<Route path="/bookmarks" element={<Guard me={me}><Bookmark /></Guard>} />`, and add it to `tests/nav-matrix.mjs`'s route list.

That's the whole loop. The backend half is generated + auto-tested; the frontend half is three obvious lines.

## Conventions

- **Naming.** Repo `XRepo`, route factory `xRoutes`, endpoint paths `/api/<plural>`, RTK hooks `useGetXQuery`/`useCreateXMutation`, test `x.test.ts`.
- **Response shapes.** Wrap collections: `{ items: [...] }` / `{ bookmarks: [...] }`, not a bare array. Mutations return `{ ok: true, ... }`.
- **Repos are thin.** No business logic that isn't a query. Cross-aggregate orchestration lives in the route or a pure module in `src/core`.
- **Pure logic is pure.** Anything reasoning about data (scoring, parsing, geo, dates) goes in `src/{ai,core,integrations,push}` as a pure function and is unit-tested — never buried in a component or handler.
- **The client never fetches by hand.** Everything is an RTK Query endpoint.

## Commands

```bash
npm test                 # all unit + integration tests
npm run test:nav         # Playwright nav matrix (needs `wrangler dev` on :8787, DEV_LOGIN=1)
npm run new:feature <x>  # scaffold a wired, tested vertical slice
npm run build-web        # build the React app → dist/site/app
npm run typecheck        # backend tsc; `npx tsc -p web/tsconfig.json --noEmit` for the web
```

See `DEPLOY.md` for the production provisioning steps.
