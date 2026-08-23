# Kept in sync with .bun-version by run_bun_version_single_source_check.
ARG BUN_VERSION=1.4.0
FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS bun

FROM node:24-alpine AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM base AS deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS build
WORKDIR /app/backend
COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend ./
COPY shared /app/shared
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app/backend
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

COPY --from=prod-deps /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/src/lib/storage/migrations/ ./dist/backend/src/lib/storage/migrations/
COPY knowledge_base/ ../knowledge_base/
COPY scenarios/ ../scenarios/

USER 1001
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/backend/src/index.js"]
