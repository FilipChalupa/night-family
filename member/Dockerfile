# syntax=docker/dockerfile:1.7
# Member — autonomous worker. Runs git, gh, and the LLM agent loop.
#
# Single `deps-prod` install scoped to @night/member — skips Household,
# household-web, and every devDependency. Cuts the runtime node_modules from
# ~all-workspace-deps to just Member + shared + tsx.

FROM node:22-alpine AS base
WORKDIR /app

# ---- prod-only install scoped to Member ----
FROM base AS deps-prod
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY household/package.json household/
COPY household/web/package.json household/web/
COPY member/package.json member/
RUN npm ci --omit=dev --workspace=@night/member --include-workspace-root

# ---- runtime stage ----
FROM node:22-alpine AS runtime
# Tools the Member needs: git for cloning, gh for PR/review actions,
# bash for Bash tool calls, tini for proper signal handling.
RUN apk add --no-cache git github-cli bash tini openssh-client ca-certificates

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps-prod /app/package.json /app/package-lock.json ./
COPY shared shared
COPY member/package.json member/package.json
COPY member/src member/src
COPY tsconfig.base.json ./

# Reuse the `node` user that ships in node:22-alpine (UID/GID 1000), which
# is what docker-compose.member.yml's `user: "1000:1000"` and `cap-drop ALL` pin to.
RUN mkdir -p /workspace && chown -R node:node /workspace /app

USER node
VOLUME ["/workspace"]

ENV WORKSPACE_DIR=/workspace

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "member/src/index.ts"]
