# Night Agents — plán

Inspirováno *Night Family* z Rick and Morty: zatímco denní „ty“ pracuješ na svém,
noční agenti převezmou rutinní úkoly. Dvě role: **Household** (ústředna,
zadávání úkolů, dohled) a **Member** (autonomní pracovník, který kód píše a
reviewuje).

## 1. Vize a cíl

- Self-hosted orchestrace AI agentů, kteří dostávají issues z GitHubu a sami je
  implementují, oponují si v review a otevírají PR.
- Uživatel zadá úkol přes web Household → Household jej rozdělí mezi připojené
  Members → Member otevře PR → **několik dalších Members (a/nebo lidé) PR
  paralelně reviewuje** → Household sleduje průběh → finální **merge dělá vždy
  člověk**.
- Dva nezávislé Docker images, aby šel Member nasadit kdekoliv (lokálně, na
  jiném stroji, ve VM…), a Household centrálně koordinoval.
- **Household nedělá žádnou AI práci** — jen orchestrace, evidence, web,
  GitHub integrace. Veškeré LLM volání běží v Members.
- Member podporuje více LLM providerů: **Anthropic, Google Gemini, OpenAI**
  (každý Member je nakonfigurován pro jeden z nich).

## 2. Architektura — high level

```
            ┌────────────────────────────┐
            │         GitHub             │
            │   (issues, PRs, repo)      │
            └─────────────┬──────────────┘
                          │ webhooks / API
                          ▼
┌─────────────────────────────────────────────┐
│           HOUSEHOLD  (NO AI)                │
│  - Web UI (přehled, zadávání, tokeny, $)    │
│  - REST + WebSocket API                     │
│  - DB (úkoly, members, tokeny, audit, cost) │
│  - Task scheduler / dispatcher              │
│  - GitHub integrace (drží GH credentials,   │
│    posílá Memberům per-task tokeny)         │
└────────┬─────────────┬─────────────┬────────┘
         │ WS          │ WS          │ WS
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ MEMBER A │  │ MEMBER B │  │ MEMBER C │
   │ Anthropic│  │  Gemini  │  │  OpenAI  │
   │ git + gh │  │ git + gh │  │ git + gh │
   └──────────┘  └──────────┘  └──────────┘
```

## 3. Household (server)

### Odpovědnosti
- **Žádná AI práce** — Household neprovádí žádné LLM volání. Pouze orchestruje,
  eviduje a zobrazuje. Cílem je, aby šel Household provozovat lacino (jen
  webserver + DB) a veškerá LLM zátěž byla v Members.
- Přehled všech připojených Members (online/offline, kapacita, aktuální úkol,
  provider, model).
- Správa **úkolů**: vytvoření, přiřazení, stavy (queued / in-progress / in-review /
  done / failed). Pro každý úkol může existovat **více paralelních review jobů**
  (různí Members + lidé).
- Správa **join-tokenů**: generování, revoke. Token nereprezentuje
  konkrétního Membera — jeden token mohou používat sdíleně desítky Member
  instancí. Identita Membera (jméno, skill tagy, provider, model) se hlásí
  v handshaku WS spojení.
- Centrální držení **GitHub credentials** (PAT / GitHub App) — Household je
  jediný, kdo je skutečně zná, Memberům posílá pouze per-task **krátkodobé
  tokeny**. **LLM API klíče Household nedrží** — každý Member si svůj klíč
  spravuje sám (env / secret manager u sebe).
- Napojení na **GitHub repo**: import issues jako úkolů, sledování PR statusů,
  webhook příjem.
- Dispatch logika: kdo dostane implementaci, kdo review (round-robin / podle
  skill tagů / podle providera / manuálně). Diverzita providerů u review
  není vynucovaná; lze ji použít jako preferenci v dispatch policy.
- Audit log — co Member dělal, jaké tool calls, kolik tokenů spálil, kolik
  to stálo.

### Tech stack (návrh)
- Node.js / TypeScript backend (snadná integrace s GitHub Octokit, sdílení
  typů s Memberem). **Žádné LLM SDK na straně Householdu.**
- Web UI: jednoduchý SPA (React / SvelteKit) nebo SSR (Next.js).
- DB: SQLite v containeru pro start (mountnutý volume), později Postgres.
- Real-time: WebSocket pro spojení s Members.
- Auth: bearer tokeny (jeden token sdílitelný mezi N Member instancemi) +
  admin login pro web UI.
- Šifrování secrets v DB (libsodium / age) — klíč drží Household z env.

### Web UI obrazovky (MVP)
1. **Dashboard** — seznam aktivních Member instancí (status, vytížení,
   provider/model), počet úkolů ve frontě, **statistiky útrat** (tokeny + $
   za den / týden / měsíc, rozpad per Member, per provider, per úkol).
   Limity si Members hlídají sami; Dashboard pouze loguje hlášené překročení.
2. **Members** — seznam aktivně připojených Member instancí (= živých WS
   spojení). Read-only detail per instance, vše hlášené v handshaku:
   `MEMBER_NAME`, skill tagy, provider, model, použitý join-token, aktuální
   úkol, historie, spotřeba tokenů a $ ze streamu eventů. Tokeny se generují
   v **Settings → Tokens** (token ≠ identita Membera — stejný token může
   používat víc instancí současně).
3. **Tasks** — kanban (queued / in-progress / in-review / approved / done),
   vytvoření úkolu ručně nebo importem z GH issue.
4. **Task detail** — popis, přiřazený Member, history událostí, link na PR,
   **seznam paralelních review jobů** (každý se svým výstupem a verdiktem),
   log tool callů, spotřeba tokenů a $.
5. **Settings** — GitHub PAT / App credentials + webhook secret per repo,
   repo bindings (více rep), default dispatch policy (kolik agentů reviewuje
   paralelně, preference providerů, …), správa **join-tokenů** pro Members
   (generování, revoke; jméno tokenu pro orientaci, scope, info kolik
   instancí ho právě používá). **Review aggregation a merge requirements
   jsou na straně GitHubu** (branch protection / required reviews per repo).

### API (hrubě)
- `POST /api/tokens`, `DELETE /api/tokens/:id` — správa join-tokenů.
- `GET /api/members` — seznam aktivně připojených Member instancí.
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`.
- `WS /ws/member` — Member se autentizuje join-tokenem a v handshaku
  nahlásí svoji identitu (jméno, skills, provider, model); dál posílá
  heartbeat + status updates a přijímá příkazy.
- `POST /webhooks/github` — příjem GH eventů (issues opened, PR review, …).
  Každý request validován HMAC SHA-256 podpisem (`X-Hub-Signature-256`)
  proti per-repo webhook secretu uloženému v Household DB; neplatný podpis
  = 401 a žádné zpracování.

## 4. Member (klient)

### Odpovědnosti
- Po startu načte konfiguraci z env: URL Householdu, **join-token**,
  vlastní identitu (jméno, skill tagy), **provider, model, LLM API key**
  a vlastní **limity** (max tokenů / cena per úkol, denní strop, …).
- Otevře WS spojení s Household, autentizuje se join-tokenem a v handshaku
  nahlásí svoji identitu (jméno, skills, provider, model). **Per-task**
  dostává od Householdu pouze: krátkodobý GitHub token, repo URL, popis
  úkolu.
- Posílá heartbeat (online/idle/busy + kapacita).
- **Vlastní limity** — Member sleduje vlastní spotřebu tokenů a $; po
  překročení svých env limitů úkol ukončí (`reason=quota_exceeded`)
  a pošle event Householdu pro audit. Household sám žádné limity
  nevynucuje.
- Čeká na přiřazení úkolu. Typy úkolů:
  - **implement** — popis → kód → PR
  - **review** — PR URL → analýza diffu → komentáře / approve / request changes
- Implement workflow:
  - Vytvoří workspace (clone repa, větev podle konvence).
  - Pustí agenta přes provider-specifický adapter (viz tech stack).
  - Streamuje progress zpět do Householdu (events: tool call, file edited,
    commit, token usage, error).
  - Pushne větev, otevře PR přes `gh`.
  - Označí úkol jako `in-review`.
- Review workflow:
  - Stáhne PR, projde diff, napíše komentáře / approve / request changes přes
    `gh`. **Více Members může reviewovat tentýž PR paralelně** — Household
    sleduje výstup každého z nich samostatně.
- Funguje jako bezstavový worker — kanonický stav drží Household. Member může
  být kdykoliv restartován bez ztráty rozdělané práce (běžící úkol Household
  buď znovu zařadí, nebo nechá expirovat).

### Tech stack
- Stejný jazyk jako Household (sdílení typů přes monorepo).
- Uvnitř containeru: `git`, `gh` CLI, Node + LLM SDK podle providera.
- **Provider adapter** — společné rozhraní (`runAgent(task, tools, stream)`),
  implementace pro:
  - **Anthropic** — Claude Agent SDK / Claude Code SDK
  - **Google Gemini** — Gemini API + agent loop
  - **OpenAI** — Responses API / Assistants API
  Adapter řeší jen rozdíly v API; nástroje (file edit, bash, …) jsou
  jednotné nad ním.
- Workspace = volume `/workspace` (per úkol vlastní podadresář, po dokončení
  smazán).
- V env Memberu žije vše, co potřebuje pro připojení (`HOUSEHOLD_TOKEN`),
  vlastní LLM (`AI_API_KEY`) a svou identitu/limity. **GitHub token Member
  v env nedrží** — přijde per-task přes WS a žije pouze v paměti procesu,
  dokud běží úkol.
- Plná síť (Docker default) — uživatel akceptuje, že Member má volný internet.

### Konfigurace (env)
- `HOUSEHOLD_URL` — např. `wss://household.local:8080`
- `HOUSEHOLD_TOKEN` — join-token vydaný Householdem (klidně sdílený mezi
  více instancemi Memberu)
- `MEMBER_NAME` — lidský identifikátor (volitelné, jinak default z Householdu)
- `MEMBER_SKILLS` — čárkou oddělené skill tagy (volitelné)
- `AI_PROVIDER` — `anthropic` / `gemini` / `openai`
- `AI_MODEL` — např. `claude-opus-4-7`, `gemini-2.x`, `gpt-…`
- `AI_API_KEY` — klíč k danému provideru

Volitelně limity, které si Member vynucuje sám (Household pouze loguje):
- `MAX_TOKENS_PER_TASK`, `MAX_COST_USD_PER_TASK`
- `MAX_COST_USD_PER_DAY` (globální denní strop)

Repo URL, per-task GitHub token a popis úkolu Member dostává od Householdu
po připojení.

## 5. Auth flow

1. Admin se přihlásí do web UI Householdu.
2. V **Settings → Tokens** klikne **„Generate token"** → zadá jméno tokenu
   (čistě pro orientaci v UI) → Household vygeneruje token (zobrazí se
   jednou, uloží se hash).
3. Admin token vloží do env Member containerů — **stejný token klidně
   i do víc containerů**, pokud chce N instancí.
4. Member se při startu připojí na WS, pošle token + handshake (vlastní
   jméno, skills, provider, model). Household ověří hash, naváže relaci
   a zaeviduje instanci v Members dashboardu.
5. Token lze kdykoliv revoknout v UI → Household uzavře všechny WS relace,
   které ho používají, a odmítne další reconnect.

## 6. Životní cyklus úkolu

```
GH issue / ruční vytvoření
        │
        ▼
   [queued] ──(scheduler vybere implement-Membera)──► [assigned]
                                                          │
                                                          ▼
                                                    [in-progress]
                                                          │
                                          (Member otevře PR)
                                                          ▼
                                                    [in-review]
                                                          │
                ┌─────────────────┬─────────────┬─────────┴─────────┐
                ▼                 ▼             ▼                   ▼
          review-job#1      review-job#2   review-job#N         lidský
          (Member X,        (Member Y,     (Member Z,           reviewer
           Anthropic)        Gemini)        OpenAI)             (volitelně)
                │                 │             │                   │
                └────────┬────────┴─────────────┴───────────────────┘
                         │
                  GitHub vyhodnotí podle nastavení repa
                  (branch protection / required reviews)
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   [changes-requested]         [awaiting-merge]
            │                         │
   (zpět in-progress,                 ▼
    nový PR push)              ČLOVĚK provede merge
                                      │
                                      ▼
                                   [done]
```

- **Finální merge dělá vždy člověk** — Members nikdy nemergují do `main`.
- Více review jobů běží **paralelně** na stejném PR; každý má vlastní
  záznam v DB (Member, provider, model, verdikt, komentáře, cost).
- **Agregaci review verdiktů řeší GitHub** podle nastavení repa (branch
  protection / required approving reviews). Household pouze sleduje
  `mergeable_state` přes webhook a podle něj přepíná `in-review` →
  `awaiting-merge` / `changes-requested`.
- Lidské reviews chodí přirozeně přes GitHub UI a započítávají se stejně
  jako agentské.
- Při selhání (timeout, error) review job → `[failed]`, ostatní jobs běží dál.
- Při selhání implement → celý úkol `[failed]`, admin může restartnout.
- Každý přechod stavu i každý review job = záznam v audit logu.

## 7. GitHub integrace

- **Credentials drží výhradně Household** (PAT nebo GitHub App, šifrovaně v DB).
  Member nikdy nedostane long-lived token — pouze krátkodobý per-task token
  scope-nutý na konkrétní repo a větev.
- **Identita v commitech**: jeden bot GitHub account (např. `night-bot`).
  Konkrétní Member, který práci udělal, se rozlišuje v commit footeru.
- **Repo bindings**: v Settings se zadá libovolný počet rep (`org/name`)
  spolu s **webhook secretem** pro daný repo. Každý úkol má pole `repo`.
  Web UI umožňuje filtrování podle repa, per-repo dispatch policy
  a per-repo metriky.
- **Webhook security**: každý příchozí GH webhook validovaný HMAC SHA-256
  podpisem (`X-Hub-Signature-256`) proti webhook secretu daného repa.
  Neplatný podpis = 401, žádné zpracování ani audit záznam.
- **Issue import**: tlačítko / webhook „issue opened“ → vytvoří úkol s odkazem.
- **PR tracking**: webhook na `pull_request` a `pull_request_review` aktualizuje
  stav úkolu (včetně human reviews); `mergeable_state` rozhoduje o přechodu
  do `awaiting-merge`.
- **Branching**: konvence `pr/night/<task-id>-<slug>`.
- **Commit messages**: každý Member podepisuje
  `Co-Authored-By: Night <member-name> <noreply@…>`.
- **Žádné automatické merge** — Members ani Household nemergují PR. Merge
  spouští výhradně člověk přes GitHub UI.

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
   - Provider adapter rozhraní + první implementace (Anthropic).
   - Spuštění na úkolu, streamování událostí zpět, audit log v Householdu.
   - Práce s git workspace, commit, branch.
   - Tracking spotřeby tokenů.

4. **M4 — GitHub integrace**
   - Octokit, repo binding, issue import, PR open přes `gh`.
   - Per-task GitHub tokeny generované Householdem.
   - Webhooky (PR, review, issues).

5. **M5 — paralelní review smyčka**
   - Dispatch více review jobů na různé Members současně.
   - Posílání review (approve / request changes / komentáře) přes `gh`.
   - Sledování `mergeable_state` z GitHub webhooku → přechod do
     `awaiting-merge` (agregaci řeší GitHub).
   - Stavový stroj kompletní (`awaiting-merge` → člověk merguje).

6. **M6 — multi-provider**
   - Adaptéry pro Gemini a OpenAI.
   - Member nahlašuje provider/model při handshaku, Household ho ukazuje v UI.
   - Dispatch policy umožňuje preferovat určitý provider pro review
     (volitelné, ne vynucené).

7. **M7 — produkční hardening**
   - HTTPS, perzistence, backup DB.
   - Šifrování secrets v DB, rotace tokenů.
   - Auditing spotřeby (alerty na hlášené quota_exceeded, weekly digest).
     Samotné cost-cap limity běží na straně Memberů, ne v Householdu.
   - Lepší UI (filtry, search, realtime updaty), grafy útrat.

