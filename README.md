# Night Family

Self-hosted orchestration of AI coding agents. A central **Household** dispatches issues from GitHub to a fleet of **Members** that write code, open PRs, and review each other. See [plan.md](plan.md) for the full design.

## Quick start (local dev)

Prerequisites: Node 22+, npm 10+, Docker (optional).

```bash
npm install
```

### Run the full stack

```bash
cp .env.household.example .env.household   # ship-it defaults already work for dev
cp .env.member.example    .env.member      # see "Run a Member" below for the token
npm run dev
```

Starts Household (backend `:8080` + Vite `:5173`) and a Member concurrently. Logs are prefixed `[hh]` / `[mem]`; Household nests its own `[be]` / `[web]` inside `[hh]`. Ctrl-C kills everything. Browse the UI at http://localhost:5173 — Vite proxies `/api`, `/auth`, and `/ws` to the backend.

`.env.household` and `.env.member` are loaded automatically by the dev scripts (Node's `--env-file-if-exists`). If they're missing, the affected process will fail on the first required env var.

Subset scripts:

- `npm run dev:household` — Household only (backend + Vite)
- `npm run dev:member` — Member only
- `npm run dev:backend --workspace @night/household` — backend without Vite
- `npm run dev:web --workspace @night/household` — Vite without the backend

Backend endpoints:

- `GET /health` — health check
- `GET /api/members` — connected Members snapshot
- `WS /ws/member` — Member fleet (bearer-token auth)
- `WS /ws/ui` — UI live updates

If you want the dashboard and UI APIs to require login, set `REQUIRE_UI_LOGIN=true` in `.env.household`. In that mode, `PRIMARY_ADMIN_GITHUB_USERNAME`, `GITHUB_OAUTH_CLIENT_ID`, and `GITHUB_OAUTH_CLIENT_SECRET` are all required, and access to the dashboard, read APIs, and UI websocket is limited to signed-in users.

Production build is served by Household itself on `:8080` after `npm run build --workspace @night/household-web`.

### Generating a Member join-token

A Member needs a join-token to connect to Household. For now, generate one with:

```bash
npx tsx -e "
import { TokenStore } from './household/src/tokens/auth.ts'
const t = new TokenStore('./.tmp/config/tokens.yaml')
const { raw } = t.create('local-dev', 'system')
console.log(raw)
"
```

Paste the printed value into `HOUSEHOLD_ACCESS_TOKEN` in `.env.member`. `AI_API_KEY=fake` is fine for M1 (no agent runs yet). After that, `npm run dev` (or `npm run dev:member`) will start a Member that registers with Household within ~1 s and shows up in `GET /api/members` and on the dashboard.

## Forwarding GitHub webhooks with smee.io

Local Household isn't reachable from GitHub. To receive `issues` / `pull_request` webhooks while developing, use [smee.io](https://smee.io):

1. Open https://smee.io and click **Start a new channel**. Copy the channel URL (e.g. `https://smee.io/abc123`).
2. In your GitHub repo: **Settings → Webhooks → Add webhook**. Set payload URL to the smee channel URL, content type `application/json`, generate a secret (paste it into Household repo bindings later).
3. Run the smee client locally to forward events to Household:
    ```bash
    npx smee-client --url https://smee.io/abc123 --target http://localhost:8080/webhooks/github
    ```
4. Push something to a branch and confirm Household receives the delivery (check `GET /api/webhook-deliveries` once that endpoint lands in M4).

Without this, you would spend an unreasonable amount of time wondering why webhook handlers never fire.

## Docker

Compose is split by where each side runs. In production, Household and Member each live on a different machine, so each gets its own file:

- `docker-compose.household.yml` — Household only.
- `docker-compose.member.yml` — Member only (no `depends_on`; reads the remote `HOUSEHOLD_URL` from `.env.member`).
- `docker-compose.dev.yml` — `include:`s both + `depends_on: household healthy`. For local dev where both run on one machine.

Local dev (both at once):

```bash
cp .env.household.example .env.household
cp .env.member.example   .env.member
# edit both to taste
docker compose -f docker-compose.dev.yml up --build
```

Household only (on the server):

```bash
cp .env.household.example .env.household
docker compose -f docker-compose.household.yml up -d --build
```

Member only (on the worker machine; `HOUSEHOLD_URL` in `.env.member` points at the remote Household):

```bash
cp .env.member.example .env.member
docker compose -f docker-compose.member.yml up -d --build
```

To require GitHub login in Docker, set `REQUIRE_UI_LOGIN=true` in `.env.household`
and fill in `PRIMARY_ADMIN_GITHUB_USERNAME`, `GITHUB_OAUTH_CLIENT_ID`, and
`GITHUB_OAUTH_CLIENT_SECRET` before starting Household.

Member containers run as UID 1000, read-only root, `cap-drop ALL`, `no-new-privileges`. Run them on a partially dedicated VM/VPS — see [plan.md §4](plan.md#4-member-klient).

## Repo layout

```
shared/      protocol types, redaction filter (used by both sides)
household/   server, web UI, GitHub integration
  src/       Hono backend (HTTP + WS, DB, auth)
  web/       React + Vite SPA
member/      autonomous worker, runs git/gh/agent loop
.github/     CI workflow
docker-compose.household.yml
docker-compose.member.yml
docker-compose.dev.yml
plan.md      design doc — single source of truth
```

## Status

Following the milestone plan in [plan.md §10](plan.md#10-fáze-milestones).

- **M1** — skeleton & connection: in progress / mostly done
- **M2** — manual tasks + estimate: not started

Track per-milestone checkboxes in plan.md.
