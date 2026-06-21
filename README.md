# Night Family

Self-hosted orchestration of AI coding agents. A central **Household** dispatches issues from GitHub to a fleet of **Members** that write code, open PRs, and review each other.

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

Member containers run as UID 1000, read-only root, `cap-drop ALL`, `no-new-privileges`. Run them on a partially dedicated VM/VPS.

> **Operator how-tos** (setting up a repo, the `night` label, the schedule UI) live on the dashboard at <code>/docs</code>. The sections below are the developer-facing summary; <code>/docs</code> is what to point a teammate at.

## How an issue becomes a PR (triage → implement)

Each labelled issue (label name: `night`) goes through two stages:

1. **Triage (any time of day).** The Member reads the issue thread and either
    - posts a clarifying question if the spec is too vague, or
    - posts a plan comment summarising what + how, plus a size estimate (S/M/L/XL).

    Triage tasks are queued for every `issues.opened` (with `night` label) and every human `issue_comment.created` on a labelled issue. As long as the human keeps replying, the cycle keeps refining. When the human stops replying, the cycle stops — there's no polling.

2. **Implement (overnight, when the schedule allows).** A plan comment from triage automatically queues an `implement` task for the same issue. It sits in the queue until a Member with the `implement` skill is available — by default that's during the night window. The implement Member opens a draft PR, runs tests, and marks it ready.

### Bot vs. human comments

Every comment, review, and PR body posted by a Member ends with a deterministic Night Family marker (`<!-- night-family:member=… task=… -->`). The webhook handler greps for it and skips re-triggering triage on Member-authored comments. Two practical implications:

- **Use a separate GitHub account for the Member's PAT** if you can. Then your manual comments and the Member's are trivially distinguishable by author login alone.
- If the PAT and the human share the same GitHub account (e.g. solo dev), the marker still does the right thing — your hand-written comments don't carry it, so they always trigger a triage cycle; the bot's do, so they never do.

### Brakes (so a chatty issue can't spam the queue)

- **Idempotence** — at most one active triage task per issue at a time. Subsequent webhook events are skipped while one is in flight.
- **Per-issue daily cap** — at most 5 triage tasks for a single issue in any rolling 24 h.
- **Per-issue lifetime cap** — at most 20 triage tasks per issue, ever. Hard ceiling against runaway loops.
- **`MAX_TOKENS_PER_DAY`** — pre-existing per-Member quota; an indirect brake on cost.

## Member schedule (when does it implement?)

The configured skill set comes from `SKILLS` env (default = all of `implement` / `review` / `triage` / `respond` / `summarize`). Whatever's there is what the Member can do _in principle_; the Member announces this static set once at handshake. The schedule then gates `implement` in time: when any `nightWindow` is active, all configured skills are offered; outside every window, `implement` is dropped and the rest pass through (so `triage`, `review`, `respond`, and `summarize` always run). Out of the box: full implementation at night (22:00–08:00 local) and during weekday lunch (12:00–13:00). The Member ships its parsed schedule to Household at handshake; Household evaluates it per session and gates dispatch accordingly. The dashboard surfaces "currently in night, ends in 4h 02m" / "next window starts in 14h 13m" on the Member detail page.

Customize by writing a `schedule.yaml`. Generate the starter and edit:

```bash
npm run -w @night/member init-schedule
```

That writes `schedule.yaml` to the repo root. Pass an explicit path with `-- /some/path.yaml` (note the `--`) to put it elsewhere, or `--force` to overwrite an existing file.

Each `nightWindow` has either `days` (weekdays it applies to) or `dates` (specific calendar dates — useful for vacations). `start` and `end` are optional `HH:MM` strings — omit both for an all-day window. `start > end` wraps past midnight.

Lookup chain (first hit wins): `SCHEDULE_FILE` env, `/etc/night-family/schedule.yaml`, `<repo-root>/schedule.yaml`, then the built-in default. For Docker, uncomment the `schedule.yaml` bind mount in [docker-compose.member.yml](docker-compose.member.yml). For `npm run dev`, just drop the file in the repo root — it's gitignored.

Admins can also push a temporary override ("Implement-only for the next 2h") from the Member detail page in the dashboard; it expires automatically.

## Member repo allowlist

A Member only works on repos its PAT can push to — at startup it pulls `/user/repos` (filtered by `permissions.push`) and ships the list to Household, which uses it as the allowlist when dispatching repo-scoped tasks. Newly granted collaborator access doesn't require a Member restart: Household asks Members to re-fetch the list when (a) a day↔night schedule edge fires, (b) a queued task arrives for a repo no Member's allowlist covers, or (c) an admin clicks "Refresh repos" on the Members panel. Members also run a slow 6-hour safety-net refresh on their own. Failures are reported back (`member.repos_error`) and surface in the Household log; the previous list is kept until the next refresh succeeds.

## Preview skill (work in progress)

A Member with the `preview` skill can spin up a project's dev server on a given
branch so changes can be looked at live. Create a `preview` task with the branch
in `metadata.branch` (the Tasks panel shows a **Branch to preview** field when
you pick the `preview` kind):

```bash
curl -X POST http://localhost:8080/api/tasks \
  -H 'content-type: application/json' \
  -d '{"kind":"preview","title":"Preview feature-x","repo":"org/name","metadata":{"branch":"feature-x"}}'
```

The Member then (see `member/src/tasks/preview.ts`):

1. checks out the branch into a throwaway worktree (`checkoutBranch` in `workspace.ts`),
2. installs deps + starts the dev server, detected from `package.json` (`dev` → `preview` → `start`),
3. **auto-detects the URL** the dev server prints on stdout/stderr (`URL_RE` +
   `normalizeUrl` rewrite `0.0.0.0`→`localhost`); `PREVIEW_BASE_PORT` is only the
   `PORT` hint + the fallback used if nothing is printed before the timeout,
4. reports the URL(s) via a `preview ready` event, and writes a **🔎 Preview**
   section into the PR opened for that branch (if any), flipping it to _Stopped_
   on teardown (`annotatePrWithPreview`),
5. holds the server open until the task is cancelled (or the wallclock limit hits),
   then tears down the server and the worktree.

**Online exposure is not wired yet** — for now the reported URL is
`http://localhost:<PREVIEW_BASE_PORT>` on the Member host. The publishing step is
pluggable (`PreviewPublisher` in `preview.ts`, default `LocalPublisher`).

Chosen direction: **Household reverse proxy.** A Member publishes a stable
Household-domain link and the Household resolves it to the live server.

**First slice (shipped): redirect.** Set `PREVIEW_PUBLISH_MODE=household` on the
Member and previews are reported as `<household>/previews/<task-id>`. Household's
`GET /previews/:taskId` route (`household/src/preview/proxy.ts`) 302-redirects to
the live server recorded on the task. It's a redirect, not a true proxy, so the
browser talks to the dev server directly — HMR/WebSocket and streaming Just Work,
and Household never fetches Member URLs server-side (no SSRF). The cost: the
target must be reachable from the viewer's browser.

**Multi-port.** A preview can expose more than one port (a web dev server plus an
API, say). Set `PREVIEW_PORTS=5173:web,3000:api` on the Member — first = primary
(the one we inject `PORT` into and wait for); extras are advertised but not
health-checked. A preview carries a _list_ of ports end-to-end —
`metadata.preview_ports: [{ port, label, url, target }]`, surfaced as one link
each in the dashboard and PR section. Additional ports resolve at
`<household>/previews/<task-id>/<port>`.

Still ahead: for the eventual subdomain-based proxy, `<port>-<id>.previews.<domain>`
wildcard routing so each dev server sees itself at an origin root (path routing
breaks root-relative assets; the redirect dodges it, a true proxy won't). And the
harder half is app-side: a frontend that hardcodes `http://localhost:<api-port>`
still needs its API's public URL injected — inherently per-project.

With `PREVIEW_PUBLISH_MODE=local` (default) previews are reported as the
Member-local `http://localhost:<port>` URL — fine for same-host dev.

### Target: subdomain proxy over the Member WebSocket (planned)

Members are laptops behind NAT, not servers — and the Member is the one that
opens the WebSocket to the Household, so **only the Household is ever reachable
inbound**. Preview traffic therefore tunnels back over that existing Member WS:
the Household is the single ingress, no Member reachability or firewall holes
required. Each `(preview, port)` gets its own subdomain
`p<port>-<task-id>.previews.<domain>` so every dev server sits at an origin root
(path routing breaks root-relative assets, HMR `wss://host/`, SW scope, cookies).

Request flow:

```
p3000-<task>.previews.<domain>
   └─ Traefik  (wildcard TLS, routes *.previews.<domain> → household:8080)
        └─ Household  (Host → (task, port) → tunnel frames over the member WS)
             └─ Member  (proxies to its local http://localhost:3000)
```

Traefik stays static (one wildcard router → Household); the Household owns the
dynamic `(task, port) → live Member session` mapping it already has from
`metadata.preview_ports` + `task.assignedSessionId`.

**Status:** the TLS/routing layer below is ready to configure; the Household-side
WS-tunnel proxy is **not implemented yet** — today only the redirect slice above
runs (`PREVIEW_PUBLISH_MODE=household`).

#### Deploying behind Traefik

Assumes you already run Traefik with the `websecure` entrypoint and a DNS-01
cert resolver (wildcard certs require DNS-01 — HTTP-01 can't issue them). Point a
wildcard DNS record `*.previews.<domain>` at the Household host, then label the
Household service (Traefik v3 syntax):

```yaml
labels:
    - traefik.enable=true
    # Main dashboard + API.
    - traefik.http.routers.household.rule=Host(`night.example.com`)
    - traefik.http.routers.household.entrypoints=websecure
    - traefik.http.routers.household.tls.certresolver=dns
    # Preview subdomains — wildcard, same backend; Household routes by Host header.
    - traefik.http.routers.previews.rule=HostRegexp(`^[a-z0-9-]+\.previews\.night\.example\.com$`)
    - traefik.http.routers.previews.entrypoints=websecure
    - traefik.http.routers.previews.tls.certresolver=dns
    - traefik.http.routers.previews.tls.domains[0].main=previews.night.example.com
    - traefik.http.routers.previews.tls.domains[0].sans=*.previews.night.example.com
    - traefik.http.services.household.loadbalancer.server.port=8080
```

(Traefik v2 uses the named form `HostRegexp(`{sub:[a-z0-9-]+}.previews.night.example.com`)`.)
Traefik forwards `Upgrade` headers on HTTP routers by default, so HMR WebSockets
pass straight through to the Household, which tunnels them on to the Member —
nothing extra to configure there.

The Household will need its previews base domain (e.g. `PREVIEWS_DOMAIN=previews.night.example.com`)
to build/validate the Host and to advertise the scheme to Members
(`PREVIEW_PUBLISH_MODE=subdomain`). Both land with the proxy implementation.

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
```

## Protocol versioning

Household and Member negotiate a semver-style `protocol_version` (string `"major.minor.patch"`) during the WebSocket handshake. The current value lives in [shared/src/protocol.ts](shared/src/protocol.ts).

| skew between sides  | what happens                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| different **major** | Household sends `handshake.reject` with `protocol_major_mismatch`; Member shuts down |
| different **minor** | accepted; both sides log a warning so fleet skew is visible                          |
| different **patch** | accepted silently                                                                    |

For this to be safe, **a minor bump may only add things** — new optional fields, new message types, new enum values the peer can ignore. Anything that removes, renames, retypes, or changes the meaning of an existing field/message is a major bump. Patch bumps must not change the wire format at all (they're for fixes that happen to live in `shared/`).

Per-version changelog lives at [docs/protocol/](docs/protocol/index.html) (rendered at https://filipchalupa.github.io/night-family/protocol/) — add an entry whenever you bump `PROTOCOL_VERSION`.

## Status

- **M1** — skeleton & connection: in progress / mostly done
- **M2** — manual tasks: not started
