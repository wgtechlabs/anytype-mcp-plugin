# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gosu procps tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts
RUN chmod +x scripts/*.sh \
    && ANYTYPE_RUNTIME_DIR=/opt/anytype scripts/setup-anytype.sh --download-only \
    && chmod -R a+rX /opt/anytype
ENV NODE_ENV=production PORT=31013 HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 31013
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
