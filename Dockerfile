# 2048verse AI 刷分 - 服务器部署镜像
# 自带 Chromium (服务器通常没有 Chrome) + 中文字体 (截图里的中文才能正常显示)
FROM node:22-bookworm-slim

# 中文字体 + Playwright Chromium 依赖的系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-noto-cjk tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖 (利用镜像层缓存)
COPY package.json package-lock.json ./
RUN (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)

# Playwright 自带 Chromium (含系统依赖)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium

COPY . .

# 数据与登录态的持久化目录
VOLUME ["/app/.chrome-profile", "/app/results"]

ENV TZ=Asia/Shanghai
ENV HEADLESS=1

# --browser chromium: 用镜像内的 Chromium; 若挂载了系统 Chrome 可用 auto
CMD ["node", "run.js", "--headless", "--newgame", "--browser", "chromium", "--session", "session.json"]
