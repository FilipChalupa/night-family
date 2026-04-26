# syntax=docker/dockerfile:1.7
# Member — autonomous worker. Runs git, gh, and the LLM agent loop.

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

# ---- runtime stage ----
FROM node:22-alpine AS runtime
# Tools the Member needs: git for cloning, gh for PR/review actions,
# bash for Bash tool calls, tini for proper signal handling.
RUN apk add --no-cache git github-cli bash tini openssh-client ca-certificates

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY shared shared
COPY member/package.json member/package.json
COPY member/src member/src
COPY tsconfig.base.json ./

# Non-root by convention; docker-compose pins to UID 1000 + cap-drop ALL.
RUN addgroup -g 1000 -S night && adduser -u 1000 -S -G night night \
	&& mkdir -p /workspace \
	&& chown -R night:night /workspace /app

USER night
VOLUME ["/workspace"]

ENV WORKSPACE_DIR=/workspace

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "member/src/index.ts"]
