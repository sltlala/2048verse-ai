#!/usr/bin/env bash
# 2048verse AI - Linux/macOS headless launcher (background + dashboard)
# Watch:  http://127.0.0.1:8765   (or SSH tunnel: ssh -L 8765:127.0.0.1:8765 user@host)
# Log:    logs/bot.log
# Stop:   ./stop.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
SHOT_INTERVAL="${SHOT_INTERVAL:-10}"

echo "============================================================"
echo "   2048verse 4x4 AI  -  HEADLESS mode (background)"
echo "============================================================"

# stop an existing instance first
if ./stop.sh --quiet 2>/dev/null; then :; fi

# browser arg
BROWSER_ARG="--browser auto"
if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 \
   && [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  BROWSER_ARG="--browser chromium"
fi

if [ ! -d node_modules/playwright ]; then
  echo "Installing node dependencies ..."
  npm install --cache ./.npm-cache --no-audit --no-fund
fi
if [ "$BROWSER_ARG" = "--browser chromium" ]; then
  npx playwright install chromium >/dev/null 2>&1 || npx playwright install --with-deps chromium
fi

mkdir -p logs results
echo "Starting in background ..."
nohup node run.js --headless --newgame --http-port "$PORT" --shot-interval "$SHOT_INTERVAL" \
      --speed 30 --budget 150 $BROWSER_ARG "$@" > logs/bot.log 2>&1 &
echo $! > .bot.pid

sleep 6
echo
echo "============================================================"
echo "  Bot started (pid $(cat .bot.pid))."
echo "    Dashboard : http://127.0.0.1:${PORT}"
echo "    Live shot : results/screenshots/live.png"
echo "    Log       : logs/bot.log"
echo "    Stop      : ./stop.sh"
echo "============================================================"
