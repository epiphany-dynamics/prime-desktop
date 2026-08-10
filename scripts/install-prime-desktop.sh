#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Building Prime Desktop..."
npm run pack

echo "Asking Desktop UI to quit cleanly (agents stay alive)..."
osascript -e 'tell application "Prime Agent" to quit' 2>/dev/null || true
# Wait up to 15s for clean before-quit detach — NEVER kill -9 the UI (that kills child workers).
for i in $(seq 1 30); do
  if ! pgrep -f '/Applications/Prime Agent.app/Contents/MacOS/Prime Agent' >/dev/null 2>&1 \
     && ! pgrep -f '/Users/.*/Applications/Prime Agent.app/Contents/MacOS/Prime Agent' >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if pgrep -f 'Prime Agent.app/Contents/MacOS/Prime Agent' >/dev/null 2>&1; then
  echo "Desktop still running after clean quit wait — leaving it alone (will not force-kill)."
  echo "Quit Prime Agent from the menu (Cmd+Q), then re-run this installer."
  exit 1
fi

rm -rf "/Applications/Prime Agent.app" "$HOME/Applications/Prime Agent.app"
ditto "dist/mac-arm64/Prime Agent.app" "/Applications/Prime Agent.app"
ditto "dist/mac-arm64/Prime Agent.app" "$HOME/Applications/Prime Agent.app"
echo "Installed. Reopening Desktop..."
open -a "Prime Agent"
echo "Done. Live sessions should reattach; workers were not force-killed."
