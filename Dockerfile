# syntax=docker/dockerfile:1
# ---------- build: compile TypeScript + native better-sqlite3
FROM node:22-bookworm-slim AS build
WORKDIR /app
# toolchain only used if no prebuilt better-sqlite3 binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/grokbot.db \
    RECORD_DIR=/data/recordings
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# /data is the persistent volume (SQLite + recordings). Fly/Railway mount volumes
# as root, so the process runs as root inside the container.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
