# Stage 1: Build client assets
FROM oven/bun:1-slim AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src/ ./src/
COPY public/ ./public/

RUN bun run build:client

# Stage 2: Runtime
FROM oven/bun:1-slim AS runtime
WORKDIR /app

COPY --from=build --chown=bun:bun /app/src/ ./src/
COPY --from=build --chown=bun:bun /app/public/ ./public/
COPY --chown=bun:bun package.json tsconfig.json ./

RUN mkdir -p /app/data && chown -R bun:bun /app/data

USER bun

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
