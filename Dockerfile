# syntax=docker/dockerfile:1
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM golang:1.26.8-alpine3.24@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS anytype-build
ARG TARGETARCH
RUN apk add --no-cache gcc musl-dev make curl tar git patch
COPY docker/anytype-cli /build-security
RUN --mount=type=cache,id=anytype-security-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=anytype-security-go-build,target=/root/.cache/go-build \
    sh /build-security/build.sh

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN apk upgrade --no-cache \
    && apk add --no-cache bash ca-certificates procps-ng tini tar setpriv \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data && chown node:node /data && chmod 700 /data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=anytype-build /out/anytype /opt/anytype/bin/anytype
COPY --from=anytype-build /out/LICENSE-anytype-cli.md /opt/anytype/LICENSE-anytype-cli.md
COPY --from=anytype-build /out/LICENSE-anytype-heart.md /opt/anytype/LICENSE-anytype-heart.md
COPY package.json ./
COPY scripts ./scripts
RUN chmod +x scripts/*.sh /opt/anytype/bin/anytype
ENV NODE_ENV=production PORT=31013 HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 31013
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD ["node", "/app/scripts/container-healthcheck.mjs"]
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
