# Night Family

Self-hosted orchestration of AI coding agents. A central **Household** dispatches issues from GitHub to a fleet of **Members** that write code, open PRs, and review each other. See [plan.md](plan.md) for the full design.

## Quick start (local dev)

Prerequisites: Node 22+, npm 10+, Docker (optional).

```bash
npm install
```

### Run Household

```bash
PRIMARY_ADMIN_GITHUB_USERNAME=your-github-login \
DATA_DIR=$(pwd)/.tmp/data \
CONFIG_DIR=$(pwd)/.tmp/config \
npm run dev:household
```

Household listens on http://localhost:8080. Endpoints:

- `GET /health` — health check
- `GET /api/members` — connected Members snapshot
- `WS /ws/member` — Member fleet (bearer-token auth)
- `WS /ws/ui` — UI live updates

### Run the web UI

In a second terminal, start Vite with API/WS proxy to the backend:

```bash
npm run dev --workspace @night/household-web
```

Visit http://localhost:5173. Production build is served by Household itself once you `npm run build --workspace @night/household-web`.

### Run a Member

Members need a join-token. For now, generate one by running:

```bash
npx tsx -e "
import { TokenStore } from './household/src/tokens/auth.ts'
const t = new TokenStore('./.tmp/config/tokens.yaml')
const { raw } = t.create('local-dev', 'system')
console.log(raw)
"
```

Then start a Member (any LLM provider — `AI_API_KEY` can be a dummy in M1 since no agent runs yet):

```bash
HOUSEHOLD_URL=ws://localhost:8080 \
HOUSEHOLD_ACCESS_TOKEN=<paste-token> \
MEMBER_NAME=alice-dev \
WORKSPACE_DIR=$(pwd)/.tmp/workspace \
AI_PROVIDER=anthropic \
AI_MODEL=claude-opus-4-7 \
AI_API_KEY=fake \
npm run dev:member
```

The Member appears in `GET /api/members` and on the dashboard within ~1 s.

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

```bash
cp .env.household.example .env.household
cp .env.member.example   .env.member
# edit both to taste
docker compose up --build
```

Member containers run as UID 1000, read-only root, `cap-drop ALL`, `no-new-privileges`. Run them on a partially dedicated VM/VPS — see [plan.md §4](plan.md#4-member-klient).

## Repo layout

```
shared/      protocol types, redaction filter (used by both sides)
household/   server, web UI, GitHub integration
  src/       Hono backend (HTTP + WS, DB, auth)
  web/       React + Vite SPA
member/      autonomous worker, runs git/gh/agent loop
.github/     CI workflow
docker-compose.yml
plan.md      design doc — single source of truth
```

## Status

Following the milestone plan in [plan.md §10](plan.md#10-fáze-milestones).

- **M1** — kostra & spojení: in progress / mostly done
- **M2** — manuální úkoly + estimate: not started

Track per-milestone checkboxes in plan.md.
