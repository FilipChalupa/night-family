# Night Agents — plán

Inspirováno *Night Family* z Rick and Morty: zatímco denní „ty“ pracuješ na svém,
noční agenti převezmou rutinní úkoly. Dvě role: **Household** (ústředna,
zadávání úkolů, dohled) a **Member** (autonomní pracovník, který kód píše a
reviewuje).

## 1. Vize a cíl

- Self-hosted orchestrace AI agentů, kteří dostávají issues z GitHubu a sami je
  implementují, oponují si v review a otevírají PR.
- Uživatel zadá úkol přes web Household → Household jej rozdělí mezi připojené
  Members → Members otevřou PR → jiný Member ho zreviewuje → Household sleduje
  průběh.
- Dva nezávislé Docker images, aby šel Member nasadit kdekoliv (lokálně, na
  jiném stroji, ve VM…), a Household centrálně koordinoval.

## 2. Architektura — high level

```
            ┌────────────────────────────┐
            │         GitHub             │
            │   (issues, PRs, repo)      │
            └─────────────┬──────────────┘
                          │ webhooks / API
                          ▼
┌─────────────────────────────────────────────┐
│                 HOUSEHOLD                   │
│  - Web UI (přehled, zadávání, tokeny)       │
│  - REST + WebSocket API                     │
│  - DB (úkoly, members, tokeny, audit)       │
│  - Task scheduler                           │
│  - GitHub integrace                         │
└──────────┬───────────────────────┬──────────┘
           │ WS (auth token)       │ WS
           ▼                       ▼
   ┌──────────────┐         ┌──────────────┐
   │   MEMBER A   │         │   MEMBER B   │
   │  (worker)    │         │  (worker)    │
   │  Claude SDK  │         │  Claude SDK  │
   │  git, gh CLI │         │  git, gh CLI │
   └──────────────┘         └──────────────┘
```

## 3. Household (server)

### Odpovědnosti
- Přehled všech připojených Members (online/offline, kapacita, aktuální úkol).
- Správa **úkolů**: vytvoření, přiřazení, stavy (queued / in-progress / in-review /
  done / failed).
- Správa **auth tokenů**: generování, revoke, scope per-member.
- Napojení na **GitHub repo**: import issues jako úkolů, sledování PR statusů,
  webhook příjem.
- Dispatch logika: kdo dostane jaký úkol (round-robin / podle skill tagů /
  manuálně).
- Audit log — co Member dělal, jaké tool calls, kolik tokenů spálil.

### Tech stack (návrh)
- Node.js / TypeScript backend (snadná integrace s Anthropic SDK i GitHub Octokit).
- Web UI: jednoduchý SPA (React / SvelteKit) nebo SSR (Next.js).
- DB: SQLite v containeru pro start (mountnutý volume), později Postgres.
- Real-time: WebSocket pro spojení s Members.
- Auth: bearer tokeny (per-member) + admin login pro web UI.

### Web UI obrazovky (MVP)
1. **Dashboard** — seznam Members (status, vytížení), počet úkolů ve frontě.
2. **Members** — detail, generování/revoke tokenu, nastavení (jméno, skill tagy).
3. **Tasks** — kanban (queued / in-progress / in-review / done), vytvoření úkolu
   ručně nebo importem z GH issue.
4. **Task detail** — popis, přiřazený Member, history událostí, link na PR,
   review výstupy, log tool callů.
5. **Settings** — GitHub PAT / App credentials, default repo, model nastavení.

### API (hrubě)
- `POST /api/members/:id/token` — vygeneruje token.
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`.
- `WS /ws/member` — Member se autentizuje tokenem, dostává příkazy, posílá
  heartbeat + status updates.
- `POST /webhooks/github` — příjem GH eventů (issues opened, PR review, …).

## 4. Member (klient)

### Odpovědnosti
- Po startu načte config (URL Household, token) z env / souboru.
- Otevře WS spojení s Household, autentizuje se, posílá heartbeat.
- Čeká na přiřazení úkolu. Po přijetí:
  - Vytvoří workspace (clone repa, větev).
  - Pustí agenta (Claude Agent SDK / Claude Code CLI) s instrukcí + nástroji.
  - Streamuje progress zpět do Household (events: tool call, file edited, commit, …).
  - Otevře PR přes `gh` CLI.
  - Označí úkol jako `in-review`.
- Když dostane review-úkol: stáhne PR, projde diff, napíše komentáře / approve /
  request changes přes `gh`.
- Funguje jako bezstavový worker — stav drží Household.

### Tech stack
- Stejný jazyk jako Household (sdílení typů přes monorepo by se hodilo).
- Uvnitř containeru: `git`, `gh` CLI, Node + Claude Agent SDK, případně Claude
  Code CLI.
- Workspace = `tmpfs` nebo mountnutý volume `/workspace`.
- Secrets (GitHub token pro push) — buď vlastní per-Member, nebo proxied přes
  Household (bezpečnější, ale komplikovanější).

### Konfigurace (env)
- `HOUSEHOLD_URL` — např. `wss://household.local:8080`
- `MEMBER_TOKEN` — vydaný Householdem
- `MEMBER_NAME` — lidský identifikátor
- `ANTHROPIC_API_KEY` — pro spuštění agenta
- `GITHUB_TOKEN` — pokud Member pushuje sám

## 5. Auth flow

1. Admin se přihlásí do web UI Householdu.
2. V sekci Members klikne **„Add member“** → zadá jméno → Household vygeneruje
   token (zobrazí se jednou, uloží se hash).
3. Admin token vloží do env nového Member containeru a spustí ho.
4. Member se připojí na WS, pošle token, Household ověří hash, naváže relaci.
5. Token lze kdykoliv revoknout v UI → Household uzavře WS, odmítne reconnect.

## 6. Životní cyklus úkolu

```
GH issue / ruční vytvoření
        │
        ▼
   [queued] ──(scheduler vybere Member)──► [assigned]
                                              │
                                              ▼
                                       [in-progress]
                                              │
                              (Member otevře PR)
                                              ▼
                                        [in-review] ──(jiný Member reviewuje)
                                              │
                          ┌───────────────────┴──────────┐
                          ▼                              ▼
                   [changes-requested]               [approved]
                          │                              │
                  (zpět in-progress)             (merge, [done])
```

- Při selhání (timeout, error) → `[failed]`, log uložen, admin může restartnout.
- Každý přechod stavu = záznam v audit logu.

## 7. GitHub integrace

- **Repo binding**: v Settings se zadá repo (`org/name`) a credentials.
- **Issue import**: tlačítko / webhook „issue opened“ → vytvoří úkol s odkazem.
- **PR tracking**: webhook na `pull_request` a `pull_request_review` aktualizuje
  stav úkolu.
- **Branching**: konvence `night/<task-id>-<slug>`.
- **Commit messages**: každý Member podepisuje `Co-Authored-By: Night Agent
  <member-name>`.

## 8. Docker setup

- `docker-compose.yml` v rootu pro lokální vývoj:
  - služba `household` (port 8080, volume na DB)
  - služba `member` (scale 1+, env z `.env.member`)
- Dva Dockerfile: `household/Dockerfile`, `member/Dockerfile`.
- Sdílený `packages/shared` (typy, protokol zpráv) — multi-stage build, oba
  images si ho zkopírují.
- Prod: Household nasazený samostatně (s reverse proxy / TLS), Members kdekoliv.

## 9. Návrh repo struktury

```
night-agents/
├─ household/        # server + web UI
│  ├─ src/
│  ├─ web/           # frontend
│  └─ Dockerfile
├─ member/           # klient
│  ├─ src/
│  └─ Dockerfile
├─ shared/           # protokol, typy
├─ docker-compose.yml
├─ .env.example
└─ plan.md
```

## 10. Fáze (milestones)

1. **M1 — kostra & spojení**
   - Skeleton Householdu (HTTP server, prázdné UI), Member container.
   - WS protokol, token auth, heartbeat.
   - Dashboard zobrazující online Members.

2. **M2 — manuální úkoly**
   - CRUD úkolů přes web UI.
   - Dispatch nejjednodušší (round-robin) a Member jen logne, co dostal.

3. **M3 — agent v Member**
   - Integrace Claude Agent SDK, spuštění na úkolu.
   - Streamování událostí zpět, audit log v Householdu.
   - Práce s git workspace, commit, branch.

4. **M4 — GitHub integrace**
   - Octokit, repo binding, issue import, PR open přes `gh`.
   - Webhooky.

5. **M5 — review smyčka**
   - Dispatch review-úkolů na druhý Member.
   - Approve / request changes přes `gh`.
   - Stavový stroj kompletní.

6. **M6 — produkční hardening**
   - HTTPS, perzistence, backup DB.
   - Limity (max úkolů na Member, timeouty, kill switch).
   - Lepší UI (filtry, search, realtime updaty).

## 11. Otevřené otázky

- **Sandbox**: má Member běžet úplně izolovaně (žádný síťový přístup mimo
  Household + GH)? Nebo plná svoboda? → vliv na bezpečnost.
- **Sekrety**: drží GitHub token Household a proxy-uje git operace, nebo má
  každý Member svůj? Nejjednodušší = každý svůj, ale větší attack surface.
- **Více repozitářů** vs. jeden — MVP asi jeden, ale model úkolu by to měl
  unést.
- **Lidský review gate** před mergem? Asi ano (alespoň konfigurovatelně), ať
  noční agenti nemergují přímo do `main`.
- **Identita Membera v commitech** — vlastní GitHub account per Member, nebo
  jeden bot account a Members se rozlišují přes Co-Authored-By?
- **Cost/limit guard** — počítadlo tokenů per úkol, hard cap, alert.
