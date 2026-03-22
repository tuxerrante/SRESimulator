FROM node:24-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
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

COPY --from=deps /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY knowledge_base/ ../knowledge_base/

USER 1001
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/backend/src/index.js"]
