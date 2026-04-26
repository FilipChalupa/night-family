# syntax=docker/dockerfile:1.7
# Household — orchestration server. No AI work happens here.

FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++
WORKDIR /app

# ---- deps stage ----
FROM base AS deps
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

# ---- runtime stage ----
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

# Copy installed deps and source. We run with tsx (no separate compile step).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY shared shared
COPY household/package.json household/package.json
COPY household/src household/src
COPY household/drizzle.config.ts household/drizzle.config.ts
COPY --from=web-build /app/household/web/dist household/web/dist
COPY tsconfig.base.json ./

# Sandbox basics — non-root user, writable dirs only via volumes.
RUN addgroup -S night && adduser -S -G night night \
	&& mkdir -p /data /config \
	&& chown -R night:night /data /config /app

USER night
VOLUME ["/data", "/config"]
EXPOSE 8080

ENV DATA_DIR=/data
ENV CONFIG_DIR=/config
ENV PORT=8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "household/src/index.ts"]
