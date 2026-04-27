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

# Reuse the `node` user that ships in node:22-alpine (UID/GID 1000), which
# is what docker-compose.member.yml's `user: "1000:1000"` and `cap-drop ALL` pin to.
# Creating our own `night` user at GID 1000 would conflict; reusing avoids
# the duplicate.
RUN mkdir -p /workspace && chown -R node:node /workspace /app

USER node
VOLUME ["/workspace"]

ENV WORKSPACE_DIR=/workspace

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "member/src/index.ts"]
