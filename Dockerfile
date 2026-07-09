# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build:server && npm run build:debug

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV BOOP_ENABLE_LOCAL_EMBEDDINGS=false
ENV BOOP_ENABLE_BGE_MODEL=false
ENV BOOP_EMBEDDINGS_CACHE_DIR=/tmp/boop-embeddings-cache
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/debug/dist ./dist/debug
COPY package*.json ./
EXPOSE 3456
USER node
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
