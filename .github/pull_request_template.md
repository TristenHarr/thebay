## What & why

<!-- One or two sentences. Link any issue. -->

## Checklist

- [ ] `npm run verify` passes (typecheck + tests)
- [ ] New logic is tested (pure fn / repo test / HTTP-route test)
- [ ] New routes are added to `src/worker/routes/index.ts` (auto-mounted + auto-tested)
- [ ] Invariants pushed into the schema where possible (FK / CHECK / UNIQUE)
- [ ] No secrets committed; `.dev.vars.example` updated if a new var was added
- [ ] User-facing screens have a `data-testid` and (if a new route) a nav-matrix entry
