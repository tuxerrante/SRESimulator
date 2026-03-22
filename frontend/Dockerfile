FROM node:24-alpine AS base
ARG NPM_VERSION=11.12.0
RUN npm install --global "npm@${NPM_VERSION}"

FROM base AS deps
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM base AS build
WORKDIR /app/frontend
COPY --from=deps /app/frontend/node_modules ./node_modules
COPY frontend ./
COPY shared /app/shared
RUN npm run build -- --webpack

FROM base AS run
WORKDIR /app/frontend
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=build /app/frontend/public ./public
COPY --from=build --chown=1001:1001 /app/frontend/.next/standalone ./
COPY --from=build --chown=1001:1001 /app/frontend/.next/static ./.next/static

USER 1001
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
