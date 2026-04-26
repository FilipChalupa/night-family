# Night Agents — plán

Inspirováno *Night Family* z Rick and Morty: zatímco denní „ty" pracuješ na svém,
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
│  - Web UI (přehled, zadávání, $)            │
│  - REST + WebSocket API                     │
│  - DB /data (úkoly, audit, eventy)          │
│  - Config /config YAML (users, tokeny)      │
│  - Task scheduler / dispatcher (hybrid pull)│
│  - GitHub integrace (drží GH credentials)   │
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
- Přehled všech připojených Members (online/offline, aktuální úkol,
  provider, model, použitý token).
- Správa **úkolů**: vytvoření, přiřazení, stavy (new / estimating / queued /
  assigned / in-progress / in-review / awaiting-merge / done / failed /
  disconnected). Pro každý úkol může existovat **více paralelních review
  jobů** (různí Members + lidé).
- Správa **join-tokenů**: generování, ruční revoke. **Tokeny nikdy
  neexpirují automaticky** (zatím; rotace = manuální revoke + vygenerovat
  nový). Token nereprezentuje konkrétního Membera — jeden token mohou
  používat sdíleně desítky Member instancí. Per token Household drží
  audit: kdo a kdy ho vytvořil, kdo zrevoknul, kteří Members se s ním kdy
  připojili. Identita Membera (jméno, skill tagy, provider, model) se
  hlásí v handshaku WS spojení.
- Centrální držení **GitHub PAT** (event. GitHub App credentials) —
  Household je jediný, kdo drží long-lived credentials v DB (šifrovaně),
  a po dispatchi je **sdílí s Memberem** pro daný úkol. „Per-task
  scopovaný token" pro PAT není reálné, takže se prostě sdílí. (S GitHub
  Appem by šly installation tokens; MVP počítá s PAT.)
  **LLM API klíče Household nedrží** — každý Member si svůj klíč
  spravuje sám (env / secret manager u sebe).
- **Napojení na GitHub repo**: import issues s labelem `night`, sledování
  PR statusů, příjem webhooků s HMAC validací.
- **Dispatch — hybridní pull**:
  1. Member po startu nebo dokončení úkolu pošle `member.ready`.
  2. Household v reakci pošle `task.assigned` (push), pokud má vhodný úkol.
  3. Member ack-uje. Pokud nepřijde `task.ack` do 30 s, Household úkol
     vrátí do queue a zkusí dalšího `member.ready`.
  4. Atomický přechod stavu úkolu `queued → assigned` v DB transakci.
  Žádné race conditions ani polling — Member je vždy „ready nebo busy".
- **Audit log** — co Member dělal, jaké tool calls, kolik tokenů spálil.
  Eventy procházejí redaction filtrem v Memberu před odesláním (viz §4).
  Retence raw eventů 90 dní (per-task aggregát zůstává navždy).

### Tech stack (návrh)
- Node.js / TypeScript backend (snadná integrace s GitHub Octokit, sdílení
  typů s Memberem). **Žádné LLM SDK na straně Householdu.**
- Web UI: jednoduchý SPA (React / SvelteKit) nebo SSR (Next.js).
- DB: SQLite v containeru pro start (volume), později Postgres.
- **Persistence volumes**:
  - `/data` — hlavní SQLite DB (úkoly, audit log, eventy). **Není
    zálohovaná** — pokud Household spadne, postavíme nový. Nic v DB
    není unikátní/nereprodukovatelné.
  - `/config` — separátní volume s YAML soubory: `users.yaml` (GitHub
    uživatelé + role admin/readonly) a `tokens.yaml` (join-tokeny + audit
    kdo/kdy vytvořil, log použití). Tento volume **má smysl zálohovat**
    nezávisle (rsync, git push do private repa) — jeho obnova šetří admin
    práci s onboardingem Members.
- Real-time: WebSocket pro spojení s Members.
- Auth:
  - **Web UI** — GitHub OAuth. Při startu vyžadováno
    `ADMIN_GITHUB_USERNAME` (root admin); další uživatelé se přidávají
    přes UI s rolí `admin` / `readonly`. Persistuje se v
    `/config/users.yaml`.
  - **Members** — bearer tokeny v WS handshaku (jeden token sdílitelný
    mezi N instancemi).
- Šifrování secrets v DB (libsodium / age) — klíč drží Household z env.
- `/health` endpoint — `GET /health` → `{ status, db, uptime }`.

### Web UI obrazovky (MVP)
1. **Dashboard** — seznam aktivních Member instancí (status, vytížení,
   provider/model, použitý token), počet úkolů ve frontě, **statistiky
   útrat** (tokeny + $ za den / týden / měsíc, rozpad per Member, per
   provider, per úkol). Limity si Members hlídají sami; Dashboard pouze
   loguje hlášené překročení.
2. **Members** — seznam aktivně připojených Member instancí (= živých WS
   spojení). Read-only detail per instance, vše hlášené v handshaku:
   `MEMBER_NAME`, skill tagy, provider, model, worker profile, použitý
   token, aktuální úkol, historie, spotřeba tokenů a $ ze streamu eventů.
3. **Tasks** — kanban (queued / in-progress / in-review / awaiting-merge /
   done / failed), vytvoření úkolu ručně nebo importem z GH issue.
4. **Task detail** — popis, estimace (size + blockers), přiřazený Member,
   history událostí, link na PR, **seznam paralelních review jobů**
   (každý se svým výstupem a verdiktem), log tool callů, spotřeba
   tokenů a $.
5. **Users** — seznam GitHub uživatelů s přístupem do UI, role
   `admin` / `readonly`. Root admin (`ADMIN_GITHUB_USERNAME`) je vždy
   admin a nelze ho odebrat.
6. **Settings** — GitHub PAT (event. App credentials) + webhook secret
   per repo, repo bindings (více rep), default dispatch policy (kolik
   agentů reviewuje paralelně, preference providerů), správa **join-tokenů**
   (generování, revoke; jméno tokenu pro orientaci, audit kdo a kdy
   vytvořil + log použití). **Review aggregation a merge requirements
   jsou na straně GitHubu** (branch protection / required reviews per repo).

### API (hrubě)
- `GET /health` — health check.
- `GET /auth/github`, `GET /auth/github/callback` — OAuth handshake.
- `GET /api/users`, `POST /api/users`, `DELETE /api/users/:username` —
  správa adminů a readonly uživatelů.
- `POST /api/tokens`, `DELETE /api/tokens/:id` — správa join-tokenů.
- `GET /api/tokens/:id/audit` — kdo vytvořil + log použití (Members).
- `GET /api/members` — seznam aktivně připojených Member instancí.
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`.
- `WS /ws/member` — Member auth + handshake (viz §11 WS protokol).
- `POST /webhooks/github` — příjem GH eventů (issues opened, PR review,
  …). Každý request validován HMAC SHA-256 podpisem
  (`X-Hub-Signature-256`) proti per-repo webhook secretu uloženému
  v Household DB; neplatný podpis = 401 a žádné zpracování.

### Konfigurace (env)
- `HOUSEHOLD_NAME` — pojmenování instance Householdu (default
  `Somnambulator`). Zobrazuje se v hlavičce web UI a v handshake response
  Memberům, ať si Member loguje, ke které ústředně je připojený.
- `ADMIN_GITHUB_USERNAME` — GitHub login root admina (povinné při startu).
  Tento uživatel se zaeviduje v `/config/users.yaml` jako první admin
  a nelze ho odebrat.
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` — credentials
  pro GitHub OAuth login do web UI.
- `SECRETS_KEY` — encryption key pro secrets v DB.

## 4. Member (klient)

### Odpovědnosti
- Po startu načte konfiguraci z env: URL Householdu, **join-token**,
  vlastní identitu (jméno, skill tagy), **provider, model, LLM API key**,
  worker profile a vlastní limity.
- Otevře WS spojení s Household, autentizuje se join-tokenem a v handshaku
  nahlásí svoji identitu (jméno, skills, provider, model, worker profile).
  Po dispatchi dostane od Householdu: GitHub PAT (v paměti, sdílený
  s ostatními Members), repo URL, popis úkolu a případně obsah
  `.night/instructions.md` z target repa.
- **Kapacita = 1 úkol v okamžik.** Žádný paralelní task v jedné instanci —
  pro víc paralelní práce stačí spustit víc Member containerů.
- Posílá heartbeat (online/idle/busy) + `member.ready` po startu /
  dokončení úkolu (signál pro hybridní pull dispatcher).
- Typy úkolů:
  - **estimate** — krátký analytický úkol: Member projde issue/popis,
    vrátí `{ size: S|M|L|XL, blockers: string[] }`. Bez git operací.
  - **implement** — popis → kód → PR.
  - **review** — PR URL → analýza diffu → komentáře / approve /
    request changes (přes `gh`).
- Implement workflow:
  - Workspace v `/workspace/<task-id>/` (git worktree z bare clonu
    cached v `/workspace/.cache/<owner>/<repo>.git`).
  - **Draft PR otevře hned po prvním commitu** — průběžný progress
    je viditelný v PR live.
  - **Commit po každém logickém kroku, push okamžitě.** Žádný „velký
    commit na konci". Důvod: práce přežije restart Memberu i výpadek
    Householdu.
  - Streamuje progress events Householdu (s redaction před odesláním).
  - Po dokončení převede PR z draft do ready for review, status úkolu
    `in-progress` → `in-review`.
- Review workflow:
  - Stáhne PR, projde diff, napíše komentáře / approve / request changes
    přes `gh`. **Self-review je povolený** (Member může reviewovat svoji
    vlastní implementaci — default dispatch primárně preferuje jiné
    Members, pokud jsou k dispozici).
  - **Více Members může reviewovat tentýž PR paralelně** — Household
    sleduje výstup každého z nich samostatně.
- **Vlastní limity** — Member sleduje vlastní spotřebu tokenů a $;
  po překročení svých env limitů úkol ukončí (`reason=quota_exceeded`)
  a pošle event Householdu pro audit. Household sám žádné limity
  nevynucuje.
- **Stale base** — pokud Household pošle `task.rebase_suggested`,
  Member rebasuje větev na čerstvý base. Konflikty řeší sám (přečte
  diff, navrhne řešení, commitne). Household nikdy nesahá do git stavu.
- **Repo cache** — Member drží bare clone každého repa, na kterém
  pracoval, v `/workspace/.cache/<owner>/<repo>.git`. Per úkol vytváří
  worktree, po smazání workspace zůstává cache. GC po N dnech bez použití.
- **Redaction filtr** — před odesláním eventu Householdu Member maskuje:
  AWS keys, GH PATs (`ghp_*`, `github_pat_*`), JWT, PEM bloky, řádky
  `KEY=value` v `.env*` / `*secret*` / `*credential*` / `*.pem` /
  `*.key` souborech. Pro `bash` tool calls oříznutí výstupu na 1000
  řádků + stejný regex sweep. Implementace ve sdíleném modulu.

### Reconnect & event buffering
Member je navržen tak, aby přežil výpadek Householdu bez ztráty práce.

- Eventy během úkolu Member append-uje do lokálního souboru
  `/workspace/<task-id>/events.ndjson` (jeden JSON event na řádek).
  Každý event má monotónně rostoucí `seq` per task.
- Po úspěšném odeslání eventu po WS Household ack-uje (uložením do DB).
  Member si pamatuje poslední ack-nutý `seq`.
- **Při ztrátě WS spojení Member pokračuje v práci** — agent loop
  běží dál, commity a push jdou rovnou na GitHub (Household není
  v kritické cestě). Eventy se akumulují v lokálním ndjson.
- **Po reconnectu** Member pošle `handshake` s `resumes: [{ task_id,
  last_seq }]`. Household v odpovědi pošle `events.replay_request`
  s `from_seq = last_seq + 1`, Member dosype eventy ze souboru.
- Pokud výpadek trvá > 1 h a Household žádný progress nezachytí
  (PR statickým GitHub webhookem), úkol → `[disconnected]`. Po
  reconnectu se vrací do `[in-progress]`.
- Member nemaže `events.ndjson`, dokud nemá od Householdu ack všech
  eventů daného úkolu.

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
- Workspace = volume `/workspace`, per úkol vlastní podadresář.
  Cache rep v `/workspace/.cache/`.
- V env Memberu žije vše, co potřebuje pro připojení (`HOUSEHOLD_ACCESS_TOKEN`),
  vlastní LLM (`AI_API_KEY`) a svou identitu/limity. **GitHub PAT Member
  v env nedrží** — přijde po dispatchi přes WS a žije pouze v paměti
  procesu, dokud běží úkol.
- **Sandbox**:
  - Container běží jako non-root user (UID 1000) s
    `--security-opt=no-new-privileges`.
  - Root filesystem read-only; writable jen `/workspace` (volume) a
    `/tmp` (tmpfs).
  - `--cap-drop=ALL`, žádný `--privileged`, žádný mount Docker socketu.
  - Provoz: doporučená **částečně vyhrazená VM/VPS**, oddělená od jiných
    citlivých služeb. Případný únik z kontejneru zasáhne jen tu jednu
    mašinu, ne celý host.
  - Plná síť (Docker default) — Member potřebuje GitHub, LLM API,
    npm/pip/cargo apod. Network sandbox nemá smysl.

### Konfigurace (env)
- `HOUSEHOLD_URL` — např. `wss://household.local:8080`
- `HOUSEHOLD_ACCESS_TOKEN` — join-token vydaný Householdem (klidně
  sdílený mezi více instancemi Memberu)
- `MEMBER_NAME` — lidský identifikátor (volitelné, jinak default
  z Householdu)
- `MEMBER_SKILLS` — čárkou oddělené tagy z enumu (exact match):
  `frontend`, `backend`, `infra`, `tests`, `docs`, `refactor`, `bugfix`.
  Volitelné.
- `WORKER_PROFILE` — `hard` / `medium` / `lazy` (volitelné, default
  `medium`). Hint pro dispatch i interní agent loop (jak důkladný je
  v thinking, kolik review iterací atd.).
- `AI_PROVIDER` — `anthropic` / `gemini` / `openai`
- `AI_MODEL` — např. `claude-opus-4-7`, `gemini-2.x`, `gpt-…`
- `AI_API_KEY` — klíč k danému provideru

Volitelně limity, které si Member vynucuje sám (Household pouze loguje):
- `MAX_TOKENS_PER_TASK`, `MAX_COST_USD_PER_TASK`
- `MAX_COST_USD_PER_DAY` (rolling 24 h)

Repo URL, GitHub PAT a popis úkolu Member dostává od Householdu po dispatchi.

## 5. Auth flow

### Web UI (admin / users)
1. Při startu Householdu je v env `ADMIN_GITHUB_USERNAME` (root admin).
   Tento uživatel je první zaevidovaný v `/config/users.yaml` s rolí
   `admin`.
2. Admin (a další pozvaní uživatelé) se přihlašují přes **GitHub OAuth**
   (`GET /auth/github` → callback → session).
3. V UI Users může admin přidat další GitHub uživatele s rolí `admin`
   nebo `readonly`. Root admina nelze odebrat.

### Members (join-tokeny)
1. Admin v Settings → Tokens klikne **„Generate token"** → zadá jméno
   tokenu (čistě pro orientaci v UI) → Household vygeneruje token
   (zobrazí se jednou, uloží se hash do `/config/tokens.yaml`).
2. Token se v UI eviduje: kdo a kdy vytvořil, audit použití (kteří
   Members se s ním kdy připojili — jméno instance, časový rozsah).
3. Admin token vloží do env Member containerů — **stejný token klidně
   i do víc containerů**, pokud chce N instancí.
4. Member se při startu připojí na WS, pošle token + handshake (vlastní
   jméno, skills, provider, model). Household ověří hash, naváže relaci,
   zaeviduje instanci v Members dashboardu a doplní audit log tokenu.
5. **Tokeny nikdy automaticky neexpirují** (záměrná jednoduchost). Admin
   může token kdykoliv revoknout v UI → Household uzavře všechny WS
   relace, které ho používají, a odmítne další reconnect. Zápis revoke
   do audit logu (kdo a kdy zrevoknul).

## 6. Životní cyklus úkolu

```
GH issue (label: night) / ruční vytvoření
        │
        ▼
   [new]
        │
        ▼  (Household pošle estimate task některému Memberovi)
   [estimating] ────► Member vrátí { size, blockers } ────►
        │
        ▼
   [queued]    (čeká na implement-Membera; admin může edit estimace)
        │
        ▼  (hybridní pull: ready → assigned)
   [assigned]
        │
        ▼
   [in-progress] (Member commituje + pushuje průběžně, draft PR otevřen)
        │
        ▼  (Member označí PR jako ready for review)
   [in-review]
        │
        ▼  paralelní review jobs (Members + lidé)
GitHub vyhodnotí podle nastavení repa (branch protection / required reviews)
        │
        ┌────────┴────────┐
        ▼                 ▼
[changes-requested]  [awaiting-merge]
        │                 │
zpět in-progress      ČLOVĚK provede merge
        │                 │
   nový PR push           ▼
                       [done]
```

- **Estimate job** — Household po vytvoření úkolu pošle dispatchnutému
  Memberovi `estimate` task. Member vrátí `{ size: S|M|L|XL,
  blockers: string[] }`. Admin to vidí v UI a může schválit, edit,
  nebo skipnout estimaci úplně.
- **Auto-retry failed implement tasks** — selhání úkolu se zkusí 3×
  s exp. backoff (1 min, 5 min, 15 min). Po 3. selhání → `[failed]`,
  admin může restartnout ručně.
- **Stale base detection** — Household sleduje `behind_by` na PR.
  Pokud > 0 commits, pošle Memberovi `task.rebase_suggested`. Member
  rebasuje sám (i s konflikty) — Household nikdy nesahá do git stavu.
- **Disconnect grace** — pokud Member ztratí WS, úkol zůstává
  `[in-progress]`. Member dál pracuje (push commits jdou na GitHub
  přímo). Při reconnectu Member pošle `member.resume`, dosype eventy.
  Pokud výpadek > 1 h a žádný progress nezachycen, úkol →
  `[disconnected]`. Po reconnectu se vrací do `[in-progress]`.
- **Self-review povolen** — Member může reviewovat svoji vlastní
  implementaci. Default dispatch primárně preferuje jiné Members,
  pokud jsou k dispozici.
- Více review jobů paralelně, **agregaci řeší GitHub** podle nastavení
  repa (branch protection / required approving reviews); Household
  sleduje `mergeable_state` přes webhook a podle něj přepíná
  `in-review` → `awaiting-merge` / `changes-requested`.
- Lidské reviews chodí přes GitHub UI a započítávají se stejně jako
  agentské.
- **Finální merge dělá vždy člověk** — Members ani Household nemergují
  do `main`.
- Při selhání review job → `[failed]` jen ten job, ostatní běží dál.
- Každý přechod stavu i každý review job = záznam v audit logu.

## 7. GitHub integrace

- **Credentials**: PAT (event. GitHub App) v Household DB, šifrovaně.
  Member po dispatchi dostane PAT do paměti procesu (žádné per-task
  scopování — PAT se prostě sdílí). Pokud admin použije GitHub App,
  identita bot accountu je `<app-name>[bot]`; pokud PAT, identita
  commitů je vlastník PATu.
- **Identita v commitech**: konkrétní Member, který práci udělal,
  se rozlišuje v commit footeru
  (`Co-Authored-By: Night <member-name> <noreply@…>`).
- **Repo bindings**: v Settings se zadá libovolný počet rep
  (`org/name`) spolu s **webhook secretem** pro daný repo. Každý
  úkol má pole `repo`. Web UI umožňuje filtrování podle repa,
  per-repo dispatch policy a per-repo metriky.
- **Webhook security**: každý příchozí GH webhook validovaný HMAC
  SHA-256 (`X-Hub-Signature-256`) proti webhook secretu daného repa.
  Neplatný podpis = 401, žádné zpracování ani audit záznam.
- **Issue import**: pouze issues s labelem `night`. Webhook
  `issues opened` bez tohoto labelu se ignoruje. `issues labeled`
  s přidaným `night` na existující issue → vytvoří úkol.
- **PR tracking**: webhook na `pull_request` a `pull_request_review`
  aktualizuje stav úkolu (včetně human reviews); `mergeable_state`
  rozhoduje o přechodu do `awaiting-merge`. `behind_by > 0`
  triggruje rebase suggestion na Membera. Status checks (CI v target
  repu) jsou viditelné v PR webhooku — review-Member to může promítnout
  do svého verdiktu.
- **Branching**: konvence `pr/night/<task-id>-<slug>`.
- **PR description**: Member generuje strukturovaný popis: shrnutí
  řešení, použité tools, soubory měněné, statistika tokenů a $,
  link na task v Householdu. Draft PR založí hned po prvním commitu,
  finální popis doplní při převedení do ready for review.
- **`.night/instructions.md`** — volitelný soubor v target repu, který
  Household při dispatchi přečte a pošle Memberovi v `task.assigned`
  payloadu. Free-form markdown, použije se jako system prompt addition
  pro agenta. Typický obsah: build/test/lint commands, konvence repa
  (commit format, branch naming), sensitive paths které Member nesmí
  editovat, code style preferences, „do/don't" pravidla.
- **Žádné automatické merge** — Members ani Household nemergují PR.
  Merge spouští výhradně člověk přes GitHub UI.

## 8. Docker setup

- `docker-compose.yml` v rootu pro lokální vývoj:
  - služba `household` — port 8080, volume `/data` (DB) a volume
    `/config` (YAML soubory s users + tokens).
  - služba `member` — scale 1+, env z `.env.member`, **sandbox flags**:
    ```yaml
    user: "1000:1000"
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    volumes: ["workspace:/workspace"]
    ```
    Žádný mount Docker socketu, žádný `--privileged`.
- Dva Dockerfile: `household/Dockerfile`, `member/Dockerfile`.
- Sdílený `packages/shared` (typy, protokol zpráv, redaction filter) —
  multi-stage build, oba images si ho zkopírují.
- **Prod**:
  - Household nasazený samostatně (TLS přes reverse proxy / Caddy).
  - Members na **částečně vyhrazené VM/VPS**, oddělené od jiných
    citlivých služeb. Případný únik z kontejneru zasáhne jen tu jednu
    mašinu, ne celý host.
  - Volume `/config` doporučeno zálohovat nezávisle (rsync, git push
    do private repa). Volume `/data` zálohovat netřeba — Household se
    v případě potřeby postaví znovu.

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
├─ shared/           # protokol, typy, redaction filter
├─ .github/
│  └─ workflows/
│     └─ ci.yml      # typecheck, lint, unit tests, build images
├─ docker-compose.yml
├─ .env.example
└─ plan.md
```

## 10. Fáze (milestones)

1. **M1 — kostra & spojení**
   - Skeleton Householdu (HTTP server, prázdné UI, `/health`).
   - Member container (skeleton).
   - WS protokol (handshake, ready, ping/pong, heartbeat) — viz §11.
   - Dashboard zobrazující online Members.
   - GitHub OAuth login pro web UI; `ADMIN_GITHUB_USERNAME` bootstrap.
   - Persistence: SQLite `/data` + YAML `/config`.
   - CI pipeline (GitHub Actions) — typecheck, lint, unit testy, build.

2. **M2 — manuální úkoly + estimate**
   - CRUD úkolů přes web UI.
   - Hybridní dispatch (`member.ready` → `task.assigned`).
   - **Estimate** task type (Member vrátí `{ size, blockers }`).
   - Member jen logne, co dostal (žádný agent v této fázi).

3. **M3 — agent v Member**
   - Provider adapter rozhraní + první implementace (Anthropic).
   - Sandbox container (rootless, read-only fs, no-new-privileges,
     cap-drop ALL).
   - Repo cache (bare clone + worktree per task).
   - Streamování událostí + audit log v Householdu.
   - Redaction filter na straně Memberu.
   - Práce s git workspace, **commit + push průběžně**, draft PR
     od začátku.
   - Reconnect-tolerantní (events.ndjson buffer, replay po reconnectu).
   - Tracking spotřeby tokenů.

4. **M4 — GitHub integrace**
   - Octokit, repo binding, **issue import s labelem `night`**.
   - PR open přes `gh`, PR description format (shrnutí, tools, stats).
   - PAT shared model.
   - Webhooky (PR, review, issues) s HMAC SHA-256 validací.
   - Stale base detection a `task.rebase_suggested`.
   - `.night/instructions.md` načítání z target repa.

5. **M5 — paralelní review smyčka**
   - Dispatch více review jobů na různé Members současně (self-review
     povolen, ale primárně dispatchovat na jiné).
   - Posílání review (approve / request changes / komentáře) přes `gh`.
   - Sledování `mergeable_state` z GitHub webhooku → přechod do
     `awaiting-merge` (agregaci řeší GitHub).
   - Auto-retry failed implement tasks (3× s exp. backoff).

6. **M6 — multi-provider**
   - Adaptéry pro Gemini a OpenAI.
   - Member nahlašuje provider/model při handshaku, Household ho
     ukazuje v UI.
   - Dispatch policy umožňuje preferovat určitý provider pro review
     (volitelné, ne vynucené).

7. **M7 — produkční hardening**
   - HTTPS, perzistence (config volume backup workflow přes rsync /
     git push do private repa).
   - Šifrování secrets v DB.
   - Auditing spotřeby (alerty na hlášené `quota_exceeded`, weekly digest).
   - Lepší UI (filtry, search, realtime updaty), grafy útrat.
   - Notifikace (Slack / e-mail) na klíčové eventy.

## 11. WS protokol

Spojení = TLS WS s `Authorization: Bearer <HOUSEHOLD_ACCESS_TOKEN>`
v upgrade requestu. JSON line-delimited messages. Verzování přes
`protocol_version` v handshaku — mismatch = Household pošle
`handshake.reject` a zavře.

### Member → Household

```ts
{ type: "handshake", protocol_version: 1,
  member_name: "alice-1", skills: ["frontend", "tests"],
  provider: "anthropic", model: "claude-opus-4-7",
  worker_profile: "hard" | "medium" | "lazy",
  resumes: [{ task_id, last_seq }]   // jen při reconnectu
}
{ type: "member.ready" }                         // po startu / dokončení úkolu
{ type: "member.busy", task_id }
{ type: "task.ack", task_id }                    // přijal task.assigned
{ type: "task.completed", task_id, result, pr_url? }
{ type: "task.failed", task_id, reason }
{ type: "event", task_id, seq, ts, kind, payload }
   // kind: "tool_call" | "file_edited" | "commit" | "usage" | "log" | "rebase"
{ type: "heartbeat", status: "idle" | "busy", current_task: string | null }
{ type: "pong" }
```

### Household → Member

```ts
{ type: "handshake.ack", household_name: "Somnambulator", session_id }
{ type: "handshake.reject", reason }
{ type: "task.assigned", task: {...}, github_token, repo_url, instructions_md? }
{ type: "events.replay_request", task_id, from_seq }
{ type: "task.rebase_suggested", task_id, behind_by }
{ type: "task.cancel", task_id, reason }
{ type: "ping" }
```

### Pravidla
- Eventy s `seq` jsou **monotónně rostoucí per task**. Household
  acknowledguje přijetí eventu uložením do DB; pokud Member po
  reconnectu pošle `resumes[].last_seq`, Household v reakci pošle
  `events.replay_request` od `from_seq = last_seq + 1`.
- Member smí ack-ovat `task.assigned` jen pokud je `idle`. Pokud
  spadl mezi `member.ready` a `task.assigned`, Household po timeoutu
  (30 s) úkol vrátí do queue.
- `heartbeat` interval 15 s, `ping/pong` 30 s. Pokud Household
  nezachytí heartbeat 2 min, považuje WS za mrtvé a uzavře relaci.
  Member se snaží reconnectovat s exp. backoff (1 s, 5 s, 30 s,
  pak 1 min loop).
- Při `handshake.reject` (např. token revoknut, protocol version
  mismatch) Member ukončí proces.
