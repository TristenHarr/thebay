#!/bin/bash
# The Bay — daily scrape → publish. Installed via launchd (`npm run schedule:install`).
#
# Data-first & fail-safe: the scrape + push to the live D1 (the source of truth for
# /api and the app) run first and record an OBSERVABLE run — visible at
# https://thebay.events/api/scrape-status. The static-dashboard refresh is a
# best-effort step afterwards. Every step's outcome is logged; a failure in the
# critical path yields a non-zero exit (so launchd + the log show it clearly).

# launchd runs with a minimal PATH; make node/npm reachable.
export PATH="/Users/tristenharr/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
mkdir -p data
LOG="data/scrape.log"
log() { echo "=== $(date '+%Y-%m-%d %H:%M:%S') $* ===" >> "$LOG"; }

log "scrape start"
fail=0

# 1) Scrape all enabled sources into local SQLite (records a run + per-source results).
npm run scrape >> "$LOG" 2>&1 || { log "SCRAPE FAILED (exit $?)"; fail=1; }
# 2) Fresh JSON export (used by the static dashboard).
npm run export -- --out data/events.json >> "$LOG" 2>&1 || log "export failed (non-fatal)"

# 3) Publish to the live D1 + report the run. This is the critical path: it keeps the
#    /api + app current AND powers /api/scrape-status. Auth is the bearer token file.
if [ -f .ingest-token ]; then
  TOKEN="$(cat .ingest-token)"
  npm run push -- --url https://thebay.events --token "$TOKEN" >> "$LOG" 2>&1 || { log "PUSH FAILED (exit $?)"; fail=1; }
  npm run geocode -- --url https://thebay.events --token "$TOKEN" --limit 120 >> "$LOG" 2>&1 || log "geocode failed (non-fatal)"
else
  log "no .ingest-token — data NOT published"; fail=1
fi

# 4) Best-effort: refresh the static dashboard (events.json) via wrangler. Worker code
#    is owned by CI, so only deploy from a clean, fast-forwarded tree; skip otherwise.
if git diff --quiet && git pull --ff-only >> "$LOG" 2>&1; then
  npm run deploy >> "$LOG" 2>&1 || log "site deploy failed (non-fatal — CI owns the worker)"
else
  log "tree not clean / not fast-forwardable — skipping site deploy (data already published)"
fi

log "done (status=$([ "$fail" -eq 0 ] && echo ok || echo FAILED))"
exit "$fail"
