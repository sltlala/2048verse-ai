# 2048verse AI 刷分 - 服务器部署镜像
# 自带 Chromium (服务器通常没有 Chrome) + 中文字体 (截图里的中文才能正常显示)
#
# 国内服务器直连 Docker Hub 会超时, 所以基础镜像默认走国内镜像源,
# 需要时可用 --build-arg BASE_IMAGE=node:22-bookworm-slim 换回官方镜像。
ARG BASE_IMAGE=docker.1ms.run/library/node:22-bookworm-slim
FROM ${BASE_IMAGE}

# Debian 源换成阿里云 (国内构建快很多); bookworm 新版用 deb822 格式, 老版用 sources.list
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi

# 中文字体 + Playwright Chromium 依赖的系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-noto-cjk tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm 也走国内镜像
RUN npm config set registry https://registry.npmmirror.com

# 先装依赖 (利用镜像层缓存)
COPY package.json package-lock.json ./
RUN (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)

# Playwright 自带 Chromium (含系统依赖); 浏览器二进制走 npmmirror 更快
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
RUN npx playwright install --with-deps chromium

COPY . .

# 数据与登录态的持久化目录
VOLUME ["/app/.chrome-profile", "/app/results"]

ENV TZ=Asia/Shanghai
ENV HEADLESS=1

# --browser chromium: 用镜像内的 Chromium; 若挂载了系统 Chrome 可用 auto
# --http-port 8765 --http-host 0.0.0.0: 实时状态面板 (docker-compose 里映射到宿主机)
CMD ["node", "run.js", "--headless", "--newgame", "--browser", "chromium", "--session", "session.json", \
     "--speed", "30", "--budget", "150", "--p4", "10", \
     "--http-port", "8765", "--http-host", "0.0.0.0", "--shot-interval", "10"]
