#!/bin/bash
# Manage the daily-scrape schedule on macOS (launchd).
#   scripts/schedule.sh install | uninstall | status
# The scrape runs on a residential IP (Eventbrite blocks datacenters), so it lives
# on your Mac, not in CI. This installs the LaunchAgent that runs it daily at 08:00.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.eventers.daily"
SRC="$HERE/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-status}" in
  install)
    [ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$SRC" "$DEST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$DEST"
    launchctl enable "$DOMAIN/$LABEL"
    echo "✓ Scheduled $LABEL — daily 08:00. Logs → data/scrape.log; health → /api/scrape-status"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$DEST"
    echo "✓ Removed $LABEL"
    ;;
  run) # trigger a run now (for testing the pipeline end-to-end)
    launchctl kickstart -k "$DOMAIN/$LABEL" && echo "✓ Kicked off a run — tail data/scrape.log"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "✓ $LABEL is INSTALLED:"
      launchctl print "$DOMAIN/$LABEL" | grep -iE "state =|last exit code|program =|runatload" | sed 's/^/    /'
    else
      echo "✗ $LABEL is NOT installed. Run: npm run schedule:install"
    fi
    ;;
  *) echo "usage: $0 install|uninstall|status|run"; exit 1 ;;
esac
