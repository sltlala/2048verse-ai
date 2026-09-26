#!/usr/bin/env bash
# 2048verse AI - stop the background bot (Linux/macOS)
#   ./stop.sh            verbose
#   ./stop.sh --quiet    silent (used internally)
set -uo pipefail
cd "$(dirname "$0")"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = "1" ] || echo "$@"; }

stopped=0

# 1) pid file
if [ -f .bot.pid ]; then
  pid="$(cat .bot.pid)"
  if kill -0 "$pid" 2>/dev/null; then
    say "  [node] stopping pid $pid"
    kill "$pid" 2>/dev/null || true
    stopped=1
  fi
  rm -f .bot.pid
fi

# 2) any run.js node process
pids="$(pgrep -f 'node .*run\.js' 2>/dev/null || true)"
for p in $pids; do
  case "$(ps -p "$p" -o args= 2>/dev/null)" in
    *dsh*) : ;;
    *) say "  [node] stopping pid $p"; kill "$p" 2>/dev/null || true; stopped=1 ;;
  esac
done

sleep 3

# 3) release the Chrome profile lock
pids="$(pgrep -f '2048/\.chrome-profile' 2>/dev/null || pgrep -f '2048/.chrome-profile' 2>/dev/null || true)"
if [ -n "$pids" ]; then
  say "  [chrome] closing $(echo "$pids" | wc -w) processes"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  stopped=1
fi

sleep 2
say "  remaining run.js processes: $(pgrep -f 'node .*run\.js' 2>/dev/null | wc -l)"
say "Done."
exit 0
