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
- Správa **auth tokenů Members**: generování, revoke, scope per-member.
- Centrální držení **secrets**:
  - GitHub credentials (PAT / GitHub App) — Household je jediný, kdo je
    skutečně zná, Memberům posílá pouze per-task **krátkodobé tokeny**.
  - LLM API klíče per Member (Anthropic / Gemini / OpenAI) — uloženy
    šifrovaně, posílány Memberovi po WS handshaku jako součást konfigurace.
- Napojení na **GitHub repo**: import issues jako úkolů, sledování PR statusů,
  webhook příjem.
- Dispatch logika: kdo dostane implementaci, kdo review (round-robin / podle
  skill tagů / podle providera / manuálně). Review se schválně dispatchuje na
  jiný provider než implementace (diverzita názorů).
- Audit log — co Member dělal, jaké tool calls, kolik tokenů spálil, kolik
  to stálo.

### Tech stack (návrh)
- Node.js / TypeScript backend (snadná integrace s GitHub Octokit, sdílení
  typů s Memberem). **Žádné LLM SDK na straně Householdu.**
- Web UI: jednoduchý SPA (React / SvelteKit) nebo SSR (Next.js).
- DB: SQLite v containeru pro start (mountnutý volume), později Postgres.
- Real-time: WebSocket pro spojení s Members.
- Auth: bearer tokeny (per-member) + admin login pro web UI.
- Šifrování secrets v DB (libsodium / age) — klíč drží Household z env.

### Web UI obrazovky (MVP)
1. **Dashboard** — seznam Members (status, vytížení, provider/model), počet
   úkolů ve frontě, **statistiky útrat** (tokeny + $ za den / týden / měsíc,
   rozpad per Member, per provider, per úkol), aktivní cost-cap alerty.
2. **Members** — detail, generování/revoke tokenu, nastavení:
   - jméno, skill tagy
   - **provider** (Anthropic / Gemini / OpenAI)
   - **model** (např. `claude-opus-4-7`, `gemini-2.x`, `gpt-…`)
   - **API key** (uložen šifrovaně, posílá se Memberovi přes WS)
   - hard limit na útratu / token count
3. **Tasks** — kanban (queued / in-progress / in-review / approved / done),
   vytvoření úkolu ručně nebo importem z GH issue.
4. **Task detail** — popis, přiřazený Member, history událostí, link na PR,
   **seznam paralelních review jobů** (každý se svým výstupem a verdiktem),
   log tool callů, spotřeba tokenů a $.
5. **Settings** — GitHub PAT / App credentials, repo binding(y), default
   review policy (kolik agentů paralelně, vyžadovat lidský review, …).

### API (hrubě)
- `POST /api/members/:id/token` — vygeneruje token.
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`.
- `WS /ws/member` — Member se autentizuje tokenem, dostává příkazy, posílá
  heartbeat + status updates.
- `POST /webhooks/github` — příjem GH eventů (issues opened, PR review, …).

## 4. Member (klient)

### Odpovědnosti
- Po startu načte minimální config (URL Householdu, vlastní token) z env.
- Otevře WS spojení s Household, autentizuje se. **Po handshaku dostane od
  Householdu** kompletní konfiguraci: provider, model, API key,
  per-task GitHub token, repo URL.
- Posílá heartbeat (online/idle/busy + kapacita).
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
- **Žádné secrets v env Memberu** kromě `MEMBER_TOKEN`. Vše ostatní
  (LLM API key, GitHub token) přijde přes WS po autentizaci a žije pouze
  v paměti procesu.
- Plná síť (Docker default) — uživatel akceptuje, že Member má volný internet.

### Konfigurace (env)
- `HOUSEHOLD_URL` — např. `wss://household.local:8080`
- `MEMBER_TOKEN` — vydaný Householdem
- `MEMBER_NAME` — lidský identifikátor (volitelné, jinak default z Householdu)

Vše ostatní — provider, model, API key, repo, GitHub token — Member dostává
od Householdu po připojení.

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
                  agregace verdiktů (policy v Settings: např. „≥1 approve
                  od agenta + lidský approve" nebo „všichni approve")
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   [changes-requested]            [approved]
            │                         │
   (zpět in-progress,                 ▼
    nový PR push)             [awaiting-merge]
                                      │
                            ČLOVĚK provede merge
                                      │
                                      ▼
                                   [done]
```

- **Finální merge dělá vždy člověk** — Members nikdy nemergují do `main`.
- Více review jobů běží **paralelně** na stejném PR; každý má vlastní
  záznam v DB (Member, provider, model, verdikt, komentáře, cost).
- Lidé můžou reviewovat přímo v GitHub UI; webhook `pull_request_review`
  doplní jejich verdikt do agregace.
- Při selhání (timeout, error) review job → `[failed]`, ostatní jobs běží dál.
- Při selhání implement → celý úkol `[failed]`, admin může restartnout.
- Každý přechod stavu i každý review job = záznam v audit logu.

## 7. GitHub integrace

- **Credentials drží výhradně Household** (PAT nebo GitHub App, šifrovaně v DB).
  Member nikdy nedostane long-lived token — pouze krátkodobý per-task token
  scope-nutý na konkrétní repo a větev.
- **Identita v commitech**: jeden bot GitHub account (např. `night-bot`).
  Konkrétní Member, který práci udělal, se rozlišuje v commit footeru.
- **Repo binding**: v Settings se zadá repo (`org/name`) a credentials.
- **Issue import**: tlačítko / webhook „issue opened“ → vytvoří úkol s odkazem.
- **PR tracking**: webhook na `pull_request` a `pull_request_review` aktualizuje
  stav úkolu (včetně human reviews).
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
   - Agregace verdiktů + zápočet lidských reviews z GitHub webhooku.
   - Stavový stroj kompletní (`awaiting-merge` → člověk merguje).
   - Approve / request changes přes `gh`.

6. **M6 — multi-provider**
   - Adaptéry pro Gemini a OpenAI.
   - UI pro výběr providera/modelu per Member.
   - Review-policy: vynutit diverzitu providerů.

7. **M7 — produkční hardening**
   - HTTPS, perzistence, backup DB.
   - Šifrování secrets v DB, rotace tokenů.
   - Cost-cap hard limity (per Member, per úkol, globálně), alerty.
   - Lepší UI (filtry, search, realtime updaty), grafy útrat.

## 11. Otevřené otázky

- **Multi-repo support** — má jedna instance Householdu obsluhovat více
  GitHub repozitářů (každý úkol má pole `repo`, web UI umí filtrovat podle
  repa, nastavení per-repo policy), **nebo** je každá instance Householdu
  vázaná pevně na jeden repo (jednodušší model, méně oprávnění)? MVP zvládne
  obojí, jen je to o tom, jak postavit datový model a UI hned od začátku.
- **Branch konvence úvodní `/`** — `pr/night/<task-id>-<slug>` (předpoklad,
  git branch nesmí začínat `/`). Potvrď, jestli to bylo myšleno takto, nebo
  jinak.
- **Review policy default** — jaká agregace verdiktů spouští stav
  `awaiting-merge`? Návrhy:
  - „aspoň 1 agent approve + 0 změn requested",
  - „všichni dispatchnutí agenti approve",
  - „aspoň N approve z M agentů",
  - „vždy vyžadovat aspoň 1 lidský approve".
  Asi konfigurovatelné per repo / per úkol, ale potřebujeme rozumný default.
- **Diverzita providerů u review** — vynucovat, že review job musí běžet na
  jiném providerovi než implementace? (Hodí se proti slepým skvrnám jednoho
  modelu, ale vyžaduje aspoň 2 providery online.)
