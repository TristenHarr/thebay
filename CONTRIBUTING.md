# Contributing

Thanks for hacking on The Bay! The codebase is built to make the right way the easy way.

## The loop

1. `npm ci` (installs deps + the pre-push guard-rail hook).
2. For a new backend feature: `npm run new:feature <name>` — it scaffolds a migration,
   repo, route, and tests, and auto-wires the route into the registry. Then apply the
   migration (`npm run db:local`) and fill the generated `it.todo` red→green.
3. Write the test first. Pure logic → `src/{core,ai,integrations,push}`; data access →
   `src/storage/d1/*-repo.ts`; HTTP → `src/worker/routes/*.ts`; UI → `web/src/features/*`.
4. `npm run verify` before you push (the pre-push hook runs it for you).

## Conventions

- **Types are the contract** — zod schemas in `shared/` are shared by client + server.
- **Repos are thin**; invariants live in the SQL schema (FK / CHECK / UNIQUE).
- **All server state through RTK Query** — no hand-rolled `fetch` in components.
- Naming: repo `XRepo`, route factory `xRoutes`, endpoint `/api/<plural>`, hook `useGetX*`.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full map, the golden-path layering,
and the invariant rules.

## Tests

- `npm run verify` — typecheck (worker + web) + all unit & HTTP-route integration tests.
- `npm run test:nav` / `npm run test:actions` — Playwright (need `npm run dev` running).

Every route added to `src/worker/routes/index.ts` is automatically covered by the
integration-test harness, and every screen by the Playwright nav matrix — so nothing
ships untested by accident.
