#!/usr/bin/env bash
# 2048verse AI 刷分 - Linux / macOS 一键启动
# 用法: ./start.sh [传给 run.js 的参数...]
#   ./start.sh --headless --newgame          # 服务器无头运行
#   ./start.sh --speed 0 --budget 200        # 更快更强
set -euo pipefail
cd "$(dirname "$0")"

TOOLS_DIR="${TOOLS_DIR:-/opt}"

echo "============================================================"
echo "   2048verse 4x4  AI Auto Player  -  Setup and Run"
echo "============================================================"
echo

# ---------- 1/4 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[1/4] Node.js not found."
  if [ -x "${TOOLS_DIR}/nodejs/bin/node" ]; then
    export PATH="${TOOLS_DIR}/nodejs/bin:$PATH"
    echo "      using ${TOOLS_DIR}/nodejs"
  else
    echo "      Please install Node.js 18+ :"
    echo "        Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "        or nvm:        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
    exit 1
  fi
fi
echo "[1/4] Node.js  $(node -v)"

# ---------- 2/4 npm ----------
if ! command -v npm >/dev/null 2>&1; then
  echo "[2/4] npm not found. Please reinstall Node.js (npm is bundled)."
  exit 1
fi
echo "[2/4] npm      $(npm -v)"

# ---------- 3/4 浏览器 ----------
# 服务器上通常没有 Chrome, 使用 Playwright 自带 Chromium
BROWSER_ARG="--browser auto"
if command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 \
   || [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "[3/4] 系统 Chrome/Chromium found"
else
  echo "[3/4] No system Chrome -> use Playwright bundled Chromium"
  BROWSER_ARG="--browser chromium"
fi

# ---------- 4/4 依赖 ----------
if [ ! -d node_modules/playwright ]; then
  echo "[4/4] Installing node dependencies ..."
  npm install --cache ./.npm-cache --no-audit --no-fund
else
  echo "[4/4] Node dependencies ready"
fi

# Playwright 自带 Chromium (仅当需要时)
if [ "$BROWSER_ARG" = "--browser chromium" ]; then
  if ! npx playwright install chromium >/dev/null 2>&1; then
    echo "      Installing Chromium (first time) ..."
    npx playwright install --with-deps chromium
  fi
fi

if [ "${1:-}" = "--env-check" ]; then
  echo
  echo "Environment check finished. Game NOT started."
  exit 0
fi

echo
echo "============================================================"
echo "   Starting ... log in to your account in the browser window"
echo "   Stop: press Ctrl+C"
echo "   Data & screenshots are saved under ./results/"
echo "============================================================"
echo

exec node run.js $BROWSER_ARG "$@"
