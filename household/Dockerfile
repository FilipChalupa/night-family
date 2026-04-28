# syntax=docker/dockerfile:1.7
# Household — orchestration server. No AI work happens here.
#
# Three install passes by design:
#   - `deps`        full install incl. devDependencies (needed for the web build).
#   - `web-build`   builds household/web → static dist using `deps`.
#   - `deps-prod`   slim install for the runtime layer: only Household's runtime
#                   deps + root runtime deps (tsx). Skips Member's deps,
#                   household-web's react/mui chain, and every devDependency.
# Keeping `deps-prod` separate from `deps` means the runtime image carries no
# build tooling (vite/mui/typescript/etc.) — much smaller layers and far fewer
# inodes per redeploy.

FROM node:22-alpine AS base
WORKDIR /app

# ---- full install for build stages ----
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY household/package.json household/
COPY household/web/package.json household/web/
COPY member/package.json member/
RUN npm ci

# ---- web build stage ----
FROM deps AS web-build
COPY shared shared
COPY household/web household/web
COPY tsconfig.base.json ./
RUN npm run build --workspace @night/household-web

# ---- prod-only install for runtime ----
FROM base AS deps-prod
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY household/package.json household/
COPY household/web/package.json household/web/
COPY member/package.json member/
RUN npm ci --omit=dev --workspace=@night/household --include-workspace-root

# ---- runtime stage ----
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps-prod /app/package.json /app/package-lock.json ./
COPY shared shared
COPY household/package.json household/package.json
COPY household/src household/src
COPY household/drizzle.config.ts household/drizzle.config.ts
COPY --from=web-build /app/household/web/dist household/web/dist
COPY tsconfig.base.json ./

# Reuse the `node` user that ships in node:22-alpine (UID/GID 1000).
RUN mkdir -p /data /config && chown -R node:node /data /config /app

USER node
VOLUME ["/data", "/config"]
EXPOSE 8080

ENV DATA_DIR=/data
ENV CONFIG_DIR=/config
ENV PORT=8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "household/src/index.ts"]
