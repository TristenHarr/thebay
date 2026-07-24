#!/bin/bash
# Eventers daily scrape — invoked by launchd (see com.eventers.daily.plist) or cron.
# Runs a full scrape of all enabled sources, then leaves a fresh JSON export.

# launchd runs with a minimal PATH; make sure node/npm are reachable.
export PATH="/Users/tristenharr/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

cd "$(dirname "$0")/.." || exit 1
mkdir -p data

echo "=== $(date '+%Y-%m-%d %H:%M:%S') scrape start ===" >> data/scrape.log
npm run scrape >> data/scrape.log 2>&1
npm run export -- --out data/events.json >> data/scrape.log 2>&1
# Rebuild the static site and redeploy it to thebay.events (Cloudflare).
npm run deploy >> data/scrape.log 2>&1
# Push the fresh events into the live D1 (source of truth for the /api + app).
if [ -f .ingest-token ]; then
  npm run push -- --url https://thebay.events --token "$(cat .ingest-token)" >> data/scrape.log 2>&1
  # Backfill map coordinates for newly-seen venues (cached + rate-limited).
  npm run geocode -- --url https://thebay.events --token "$(cat .ingest-token)" --limit 120 >> data/scrape.log 2>&1
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S') scrape+deploy+push+geocode done ===" >> data/scrape.log
