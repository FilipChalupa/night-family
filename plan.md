# Night Agents — plán

Inspirováno _Night Family_ z Rick and Morty: zatímco denní „ty" pracuješ na svém,
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
│  - Web UI (přehled, zadávání, statistiky)   │
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
  neexpirují automaticky** a **rotation se záměrně neřeší** (viz §5).
  Token nereprezentuje konkrétního Membera — jeden token mohou
  používat sdíleně desítky Member instancí. Per token Household drží
  audit: kdo a kdy ho vytvořil, kdo zrevoknul, kteří Members se s ním kdy
  připojili. Identita Member instance (`member_id` — perzistentní UUID,
  `member_name` — friendly nickname, skill tagy, provider, model) se
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
    2. Household v reakci pošle `task.assigned` (push), pokud má vhodný
       úkol. **Filtruje podle skill matche**: úkol typu `implement` jde jen
       Memberu se `implement` v `MEMBER_SKILLS`, atd. Member bez požadované
       role je v dispatchu přeskočen.
    3. Member ack-uje. Pokud nepřijde `task.ack` do 30 s, Household úkol
       vrátí do queue a zkusí dalšího `member.ready`.
    4. Atomický přechod stavu úkolu `queued → assigned` v DB transakci.
       Žádné race conditions ani polling — Member je vždy „ready nebo busy".
- **Webhook idempotency** — GitHub webhooky retryují při selhání;
  Household deduplikuje přes `X-GitHub-Delivery` header (uložený
  do tabulky `webhook_deliveries`, primary key).
- **Audit log** — co Member dělal, jaké tool calls, kolik tokenů spálil.
  Eventy procházejí redaction filtrem v Memberu před odesláním (viz §4).
  Retence raw eventů 90 dní (per-task aggregát zůstává navždy).

### Tech stack (návrh)

- **Backend** — Node.js / TypeScript + **Hono** (HTTP + WS). Octokit
  pro GitHub. **Žádné LLM SDK na straně Householdu.**
- **Web UI** — **React SPA + Vite**, statika servována Honem.
- **DB** — SQLite v containeru pro start (volume), později Postgres.
  Access přes **Drizzle** (type-safe queries, generated typy ze schema),
  migrace přes **drizzle-kit**.
- **Logging** — **Pino** (JSON struktura), v dev `pino-pretty` pro
  čitelný output.
- **Testing** — **Vitest** (jednotné pro Household + Member + shared).
- **Monorepo** — **npm workspaces**: `household/`, `member/`, `shared/`.
- **Persistence volumes**:
    - `/data` — hlavní SQLite DB (úkoly, audit log, eventy).
      **Záměrně se nezálohuje.** Pokud Household spadne, postavíme nový;
      nic v DB není unikátní ani nereprodukovatelné (úkoly se přeimportují
      z GitHubu, audit log je „nice to have", ne must).
    - `/config` — separátní volume s YAML soubory: `users.yaml` (GitHub
      uživatelé + role admin/readonly) a `tokens.yaml` (join-tokeny + audit
      kdo/kdy vytvořil, log použití). **Tento volume zálohujte** nezávisle
      (rsync, git push do private repa) — obnova šetří admin práci
      s onboardingem Members.
- Real-time: WebSocket. Dva oddělené endpointy:
    - `WS /ws/member` — Member fleet (auth bearer tokenem).
    - `WS /ws/ui` — Web UI live updates (přihlášený admin/readonly,
      auth přes session cookie). Push: změny stavů úkolů, online/offline
      Members, příchozí eventy, statistiky tokenů. Žádný polling.
- Auth:
    - **Web UI** — GitHub OAuth → server-side session cookie
      (HttpOnly, Secure, SameSite=Lax), TTL 30 dní s rolling refresh.
      Session storage v SQLite. CSRF přes double-submit cookie pattern
      pro mutating endpointy. Při startu vyžadováno
      `PRIMARY_ADMIN_GITHUB_USERNAME` (root admin); další uživatelé se přidávají
      přes UI s rolí `admin` / `readonly`. Persistuje se v
      `/config/users.yaml`. **Žádná validace** username proti GitHubu —
      odpovědnost admina zadat existující login; překlep = nikdo se
      nepřihlásí.
    - **Members** — bearer tokeny v WS handshaku (jeden token sdílitelný
      mezi N instancemi).
- Šifrování secrets v DB (libsodium / age) — klíč drží Household z env.
- `/health` endpoint — `GET /health` → `{ status, db, uptime }`.

### Web UI obrazovky (MVP)

- [ ] **Dashboard** — seznam aktivních Member instancí (status, vytížení,
      provider/model, použitý token), počet úkolů ve frontě, **statistiky
      tokenů** (za den / týden / měsíc, rozpad per Member, per provider,
      per úkol). Limity si Members hlídají sami; Dashboard pouze loguje
      hlášené překročení. Žádné $ účtování — ceník per model neřešíme,
      plánujeme čistě token counts.
- [ ] **Members** — seznam aktivně připojených Member instancí (= živých WS
      spojení). Read-only detail per instance, vše hlášené v handshaku:
      `member_id` (perzistentní UUID), `member_name` (friendly), skill tagy,
      provider, model, worker profile, použitý token, aktuální úkol,
      historie, spotřeba tokenů ze streamu eventů. Historie per Member se
      klíčuje na `member_id`, takže přejmenování `MEMBER_NAME` ji neztratí.
- [ ] **Tasks** — kanban (queued / in-progress / in-review / awaiting-merge /
      done / failed), vytvoření úkolu ručně nebo importem z GH issue.
- [ ] **Task detail** — popis, estimace (size + blockers), přiřazený Member,
      history událostí, link na PR, **seznam paralelních review jobů**
      (každý se svým výstupem a verdiktem), log tool callů, spotřeba tokenů.
      Tlačítko **Cancel** (jen pro admina) — pošle `task.cancel` přes WS.
- [ ] **Users** — seznam GitHub uživatelů s přístupem do UI, role
      `admin` / `readonly`. Root admin (`PRIMARY_ADMIN_GITHUB_USERNAME`) je vždy
      admin a nelze ho odebrat.
- [ ] **Settings** — GitHub PAT (event. App credentials) + webhook secret
      per repo, repo bindings (více rep), default dispatch policy (kolik
      agentů reviewuje paralelně, preference providerů), správa **join-tokenů**
      (generování, revoke; jméno tokenu pro orientaci, audit kdo a kdy
      vytvořil + log použití), **notification channels** (outbound webhook URL
    - SMTP) a per-event subscription. **Review aggregation a merge
      requirements jsou na straně GitHubu** (branch protection / required
      reviews per repo).

### Notifikace

Místo per-service integrací (Slack SDK, Discord SDK, …) má Household
**generic outbound channels**:

- **Webhook channel** — URL + volitelné headers; Household pošle POST
  s JSON payloadem. Slack / Discord / MS Teams / n8n / Zapier fungují
  z krabice přes jejich „incoming webhook" URL bez specifické integrace.
- **SMTP / email** — host, user, pass nebo API key (SendGrid, Resend, …).

Eventy, na které se lze přihlásit (per-channel subscription):
`task.failed`, `pr.merged`, `quota_exceeded`, `summarize.result`,
`member.disconnected`, `token.revoked`.

`summarize` task vrátí markdown / JSON, který Household pošle skrz
přihlášené channely. Trigger: cron v Householdu (např. „každé pondělí
9:00 weekly digest pro repo X") nebo manuálně z UI.

**Delivery semantics.** Žádný auto-retry, žádný deadletter queue.
Pokud channel vrátí non-2xx (nebo SMTP selže), Household zaloguje
do tabulky `notification_deliveries` (channel, event, payload, status,
error). V UI Settings → Notification channels je seznam failed
deliveries s tlačítkem **Retry** — admin klikne, Household pošle znovu.

### API (hrubě)

- [ ] `GET /health` — health check.
- [ ] `GET /auth/github`, `GET /auth/github/callback` — OAuth handshake.
- [ ] `GET /api/users`, `POST /api/users`, `DELETE /api/users/:username` —
      správa adminů a readonly uživatelů.
- [ ] `POST /api/tokens`, `DELETE /api/tokens/:id` — správa join-tokenů.
- [ ] `GET /api/tokens/:id/audit` — kdo vytvořil + log použití (Members).
- [ ] `GET /api/members` — seznam aktivně připojených Member instancí.
- [ ] `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`.
- [ ] `POST /api/tasks/:id/cancel` — admin spustí cancel z UI; Household
      pošle Memberu `task.cancel` přes WS (graceful shutdown viz §11).
- [ ] `GET /api/notification-channels`, `POST /api/notification-channels`,
      `DELETE /api/notification-channels/:id` — správa outbound channelů.
- [ ] `WS /ws/member` — Member auth + handshake (viz §11 WS protokol).
- [ ] `WS /ws/ui` — push live updates do Web UI (auth přes session cookie).
- [ ] `POST /webhooks/github` — příjem GH eventů (issues opened, PR review,
      …). Každý request validován HMAC SHA-256 podpisem
      (`X-Hub-Signature-256`) proti per-repo webhook secretu uloženému
      v Household DB; neplatný podpis = 401 a žádné zpracování.

### Konfigurace (env)

- `HOUSEHOLD_NAME` — pojmenování instance Householdu (default
  `Somnambulator`). Zobrazuje se v hlavičce web UI a v handshake response
  Memberům, ať si Member loguje, ke které ústředně je připojený.
- `PRIMARY_ADMIN_GITHUB_USERNAME` — GitHub login root admina (povinné při startu).
  Tento uživatel se zaeviduje v `/config/users.yaml` jako první admin
  a nelze ho odebrat. **Žádná validace proti GitHubu** — odpovědnost
  uživatele zadat existující login. Překlep = nikdo se nepřihlásí.
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` — credentials
  pro GitHub OAuth login do web UI.
- `SECRETS_KEY` — encryption key pro secrets v DB.

## 4. Member (klient)

### Odpovědnosti

- Po startu načte konfiguraci z env: URL Householdu, **join-token**,
  vlastní identitu (jméno, skill tagy), **provider, model, LLM API key**,
  worker profile a vlastní limity.
- Otevře WS spojení s Household, autentizuje se join-tokenem a v handshaku
  nahlásí svoji identitu (`member_id`, `member_name`, skills, provider,
  model, worker profile). `member_id` je perzistentní UUID (uložené
  v `/workspace/.member-id`), `member_name` je friendly nickname, který
  nemusí být unikátní.
- Po dispatchi dostane od Householdu: GitHub PAT (v paměti, sdílený
  s ostatními Members), repo URL, popis úkolu. **Project-specific
  instrukce** (build/test commands, conventions, sensitive paths)
  Member po cloneu načte sám z target repa — hledá v pořadí:
  `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.md`, `.github/copilot-instructions.md`.
  První nalezený přiloží jako system prompt addition pro agenta.
- **Kapacita = 1 úkol v okamžik.** Žádný paralelní task v jedné instanci —
  pro víc paralelní práce stačí spustit víc Member containerů.
- Posílá heartbeat (`idle` / `busy`) + `member.ready` po startu /
  dokončení úkolu (signál pro hybridní pull dispatcher).
- Typy úkolů:
    - **estimate** — krátký analytický úkol: Member projde issue/popis,
      vrátí `{ size: S|M|L|XL, blockers: string[] }`. Bez git operací.
    - **implement** — popis → kód → PR.
    - **review** — PR URL → analýza diffu → komentáře / approve /
      request changes (přes `gh`).
    - **respond** — PR thread + nový komentář od reviewera → Member
      odpoví v threadu (přes `gh`), bez nutnosti commitu. Drží konverzaci
      aktivní, dokud reviewer nepotvrdí změnu nebo neuzavře téma.
    - **summarize** — vstup: období + seznam repos + cíl (weekly digest /
      daily standup / status update). Member vrátí markdown / JSON,
      Household ho pošle skrz nakonfigurované notification channels.
- Implement workflow:
    - Workspace v `/workspace/<task-id>/` (git worktree z bare clonu
      cached v `/workspace/.cache/<owner>/<repo>.git`).
    - **Base branch** = default branch repa, zjištěný přes
      `git symbolic-ref refs/remotes/origin/HEAD`. Žádná konfigurace
      per repo / per task, prostě hlavní větev.
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
- **Vlastní limity** — Member sleduje vlastní spotřebu tokenů; po
  překročení svých env limitů úkol ukončí (`reason=quota_exceeded`)
  a pošle event Householdu pro audit. Household sám žádné limity
  nevynucuje.
- **Hard wallclock limit** — Member ukončí úkol po `MAX_TASK_DURATION_MINUTES`
  (default 120 min) bez ohledu na stav agent loopu. Reason
  `timeout_exceeded`. Brání nekonečnému loopu agenta.
- **Workspace cleanup** — Member smaže `/workspace/<task-id>/` až poté,
  co Household ack-uje všechny eventy daného úkolu **+ 24 h grace
  period** (kdyby admin chtěl ručně sáhnout do workspace).
- **Stale base** — pokud Household pošle `task.rebase_suggested`,
  Member rebasuje větev na čerstvý base. Konflikty řeší sám (přečte
  diff, navrhne řešení, commitne). Household nikdy nesahá do git stavu.
- **Repo cache** — Member drží bare clone každého repa, na kterém
  pracoval, v `/workspace/.cache/<owner>/<repo>.git`. Per úkol vytváří
  worktree, po smazání workspace zůstává cache. GC po **7 dnech** bez
  použití. Cache je per-container (= per Member instance) — žádný
  sharing mezi Members, žádné concurrent locky k řešení.
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
- **Velikost bufferu je přirozeně bounded.** Bez Householdu Member
  nedostane další úkol (`member.ready` se nemá kde doručit), takže
  ndjson roste jen pro aktuální task. Žádný explicit cap ani rotation
  policy zatím nepotřebujeme.

### Tech stack

- Stejný jazyk (TypeScript) jako Household, sdílení typů přes
  `shared/` package v npm workspaces. Stejný stack: **Pino** logging,
  **Vitest** testing.
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
- `MEMBER_NAME` — friendly nickname pro UI, **nemusí být unikátní**
  (víc instancí může sdílet stejný název). Volitelné, default odvozen
  z hostname.

`member_id` (perzistentní UUID v4) Member generuje sám při prvním startu
a uloží do `/workspace/.member-id`; při dalším startu ho odtud načte.
Žádný env override — volume reset = nový ID = nový Member z pohledu
Householdu.

- `MEMBER_SKILLS` — čárkou oddělené role z enumu (exact match):
  `implement`, `review`, `estimate`, `respond`, `summarize`. Default
  `implement,review,estimate,respond,summarize` (Member umí všechno).
  Pro dedikované workery (např. cheap LLM jen na review) lze omezit.
- `WORKER_PROFILE` — `hard` / `medium` / `lazy` (volitelné, default
  `medium`). Hint pro dispatch i interní agent loop (jak důkladný je
  v thinking, kolik review iterací atd.).
- `AI_PROVIDER` — `anthropic` / `gemini` / `openai`
- `AI_MODEL` — např. `claude-opus-4-7`, `gemini-2.x`, `gpt-…`
- `AI_API_KEY` — klíč k danému provideru

Volitelně limity, které si Member vynucuje sám (Household pouze loguje).
**Žádné $ limity** — ceník per model nikde neřešíme, počítáme čistě tokeny.

- `MAX_TOKENS_PER_TASK`
- `MAX_TOKENS_PER_DAY` (rolling 24 h)
- `MAX_TASK_DURATION_MINUTES` (default 120) — hard wallclock limit
  per úkol

Repo URL, GitHub PAT a popis úkolu Member dostává od Householdu po dispatchi.

## 5. Auth flow

### Web UI (admin / users)

1. Při startu Householdu je v env `PRIMARY_ADMIN_GITHUB_USERNAME` (root admin).
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
   Members se s ním kdy připojili — `member_id` + `member_name` +
   časový rozsah).
3. Admin token vloží do env Member containerů — **stejný token klidně
   i do víc containerů**, pokud chce N instancí.
4. Member se při startu připojí na WS, pošle token + handshake (vlastní
   jméno, skills, provider, model). Household ověří hash, naváže relaci,
   zaeviduje instanci v Members dashboardu a doplní audit log tokenu.
5. **Tokeny nikdy automaticky neexpirují** (záměrná jednoduchost). Admin
   může token kdykoliv revoknout v UI → Household uzavře všechny WS
   relace, které ho používají, a odmítne další reconnect. Zápis revoke
   do audit logu (kdo a kdy zrevoknul).
6. **Token rotation záměrně neřešíme.** Žádný „vygeneruj nový → nech
   překrýt → revoke starý" pattern; revoke = okamžitý disconnect celého
   fleetu, který token používá. Pokud bude potřeba, doplníme později;
   pro teď je to zbytečná komplikace.

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
- **Minimální permissions PAT** — doporučujeme **fine-grained PAT**
  scoped na konkrétní repos (modernější, expirovatelný); classic PAT
  alternativa níže.

    _Fine-grained PAT — repository permissions:_
    - **Contents** — Read and write (clone, push, branch operations)
    - **Issues** — Read and write (import s labelem `night`, komentáře,
      label changes)
    - **Pull requests** — Read and write (open PR, komentáře,
      approve / request changes přes `gh`)
    - **Workflows** — Read and write (Member smí editovat
      `.github/workflows/*.yml`; bez tohoto scope-u GitHub odmítne push,
      který tyto soubory mění)
    - **Actions** — Read (status checks v PR; review-Member je promítá
      do verdiktu)
    - **Commit statuses** — Read
    - **Metadata** — Read (povinné, default)
    - **Webhooks** — **MVP: nepoužíváme.** Admin webhook přidá ručně
      v repo Settings → Webhooks (jednorázové klikání, šetří jeden PAT
      scope a registrační kód v Householdu). Auto-registraci necháme
      na později, až bude nasazení častější.

    _Classic PAT alternativa_ (jednodušší, méně granulární): scope
    `repo` (full) + `workflow`.

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
  řešení, použité tools, soubory měněné, statistika tokenů, link na
  task v Householdu. Draft PR založí hned po prvním commitu,
  finální popis doplní při převedení do ready for review.
- **Závislosti mezi úkoly** — Night nemá strukturované `depends_on`.
  Pokud admin v popisu úkolu zmíní, že práce závisí na jiném issue / PR
  (např. „blokováno #42"), Member tu poznámku **promítne do PR
  description** sekce „Depends on". Sekvenční merge si pohlídá člověk
  při finálním merge.
- **Project instructions** — Member po cloneu prohledá target repo na
  známé agent config soubory (priorita: `AGENTS.md`, `CLAUDE.md`,
  `.cursor/rules/*.md`, `.github/copilot-instructions.md`) a první
  nalezený použije jako system prompt addition. Žádná Night-specific
  konvence; spoléháme na to, co projekt už typicky má.
- **Žádné automatické merge** — Members ani Household nemergují PR.
  Merge spouští výhradně člověk přes GitHub UI.

## 8. Docker setup

- `docker-compose.yml` v rootu pro lokální vývoj:
    - služba `household` — port 8080, volume `/data` (DB) a volume
      `/config` (YAML soubory s users + tokens).
    - služba `member` — scale 1+, env z `.env.member`, **sandbox flags**:
        ```yaml
        user: '1000:1000'
        read_only: true
        tmpfs: [/tmp]
        cap_drop: [ALL]
        security_opt: ['no-new-privileges:true']
        volumes: ['workspace:/workspace']
        ```
        Žádný mount Docker socketu, žádný `--privileged`.
- Dva Dockerfile: `household/Dockerfile`, `member/Dockerfile`.
- Sdílený `packages/shared` (typy, protokol zpráv, redaction filter) —
  multi-stage build, oba images si ho zkopírují.
- **Prod**:
    - Household nasazený samostatně. **TLS je out of scope** — řeší
      externí reverse proxy / load balancer (Caddy, Traefik, nginx,
      cloud LB), na které Household sedí.
    - Members na **částečně vyhrazené VM/VPS**, oddělené od jiných
      citlivých služeb. Případný únik z kontejneru zasáhne jen tu jednu
      mašinu, ne celý host.
    - Volume `/config` zálohovat nezávisle (rsync, git push do private
      repa). Volume `/data` **záměrně bez backupu** — Household se
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

1. **M1 — kostra & spojení** — [x]
    - [x] Skeleton Householdu (Hono HTTP + WS, React+Vite UI skeleton, `/health`).
    - [x] Member container (skeleton, sandbox flags v compose).
    - [x] WS protokol (handshake, ready, ping/pong, heartbeat) — viz §11.
    - [x] Dashboard zobrazující připojené Members.
    - [x] GitHub OAuth login pro web UI; `PRIMARY_ADMIN_GITHUB_USERNAME` bootstrap.
    - [x] Persistence: SQLite `/data` (Drizzle + drizzle-kit migrace) +
          YAML `/config`.
    - [x] CI pipeline (GitHub Actions) — typecheck, lint, Vitest, build.
    - [x] Local dev docs: **smee.io** pro forward GH webhooků na localhost
          (jinak člověk strávil dlouho debugováním, proč webhook nepřichází).

2. **M2 — manuální úkoly + estimate** — [x]
    - [x] CRUD úkolů přes web UI.
    - [x] Hybridní dispatch (`member.ready` → `task.assigned`).
    - [x] **Estimate** task type (Member vrátí `{ size, blockers }`).
    - [x] Member jen logne, co dostal (žádný agent v této fázi).

3. **M3 — agent v Member** — [ ]
    - [ ] Provider adapter rozhraní + první implementace (Anthropic).
    - [ ] Sandbox container (rootless, read-only fs, no-new-privileges,
          cap-drop ALL).
    - [ ] Repo cache (bare clone + worktree per task).
    - [ ] Streamování událostí + audit log v Householdu.
    - [ ] Redaction filter na straně Memberu.
    - [ ] Práce s git workspace, **commit + push průběžně**, draft PR
          od začátku.
    - [ ] Reconnect-tolerantní (events.ndjson buffer, replay po reconnectu).
    - [ ] Tracking spotřeby tokenů.

4. **M4 — GitHub integrace** — [ ]
    - [ ] Octokit, repo binding, **issue import s labelem `night`**.
    - [ ] PR open přes `gh`, PR description format (shrnutí, tools, stats).
    - [ ] PAT shared model.
    - [ ] Webhooky (PR, review, issues) s HMAC SHA-256 validací.
    - [ ] Stale base detection a `task.rebase_suggested`.
    - [ ] Načítání standardních agent config souborů z target repa
          (`AGENTS.md`, `CLAUDE.md`, …) v Memberu po cloneu.

5. **M5 — paralelní review smyčka** — [ ]
    - [ ] Dispatch více review jobů na různé Members současně (self-review
          povolen, ale primárně dispatchovat na jiné).
    - [ ] Posílání review (approve / request changes / komentáře) přes `gh`.
    - [ ] Sledování `mergeable_state` z GitHub webhooku → přechod do
          `awaiting-merge` (agregaci řeší GitHub).
    - [ ] Auto-retry failed implement tasks (3× s exp. backoff).

6. **M6 — multi-provider** — [ ]
    - [ ] Adaptéry pro Gemini a OpenAI.
    - [ ] Member nahlašuje provider/model při handshaku, Household ho
          ukazuje v UI.
    - [ ] Dispatch policy umožňuje preferovat určitý provider pro review
          (volitelné, ne vynucené).

7. **M7 — produkční hardening + rozšířené role** — [ ]
    - [ ] HTTPS, perzistence (config volume backup workflow přes rsync /
          git push do private repa).
    - [ ] Šifrování secrets v DB.
    - [ ] **Notification channels** — outbound webhook + SMTP, per-event
          subscription (`task.failed`, `pr.merged`, `quota_exceeded`,
          `summarize.result`, `member.disconnected`, `token.revoked`).
          Slack / Discord / MS Teams atd. přes jejich incoming webhook URL
          bez specifické integrace.
    - [ ] **`respond` task type** — Member odpovídá na PR thread komentáře
          bez nutnosti commitu.
    - [ ] **`summarize` task type** — cron v Householdu nebo manuální trigger
          z UI; Member generuje markdown digest, Household ho pošle channely.
    - [ ] Auditing spotřeby (alerty na hlášené `quota_exceeded`, weekly digest).
    - [ ] Lepší UI (filtry, search, realtime updaty), grafy útrat.

## 11. WS protokol

Spojení = TLS WS s `Authorization: Bearer <HOUSEHOLD_ACCESS_TOKEN>`
v upgrade requestu. JSON line-delimited messages. Verzování přes
`protocol_version` v handshaku — mismatch = Household pošle
`handshake.reject` a zavře.

### Member → Household

```ts
{ type: "handshake", protocol_version: 1,
  member_id: "550e8400-e29b-41d4-a716-446655440000",   // perzistentní UUID
  member_name: "alice-laptop",                         // friendly, ne nutně unikátní
  skills: ["implement", "review", "estimate", "respond", "summarize"],
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
{ type: "task.assigned", task: {...}, github_token, repo_url }
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
- **`task.cancel` chování** — Member po přijetí cancel zprávy přejde
  do **graceful shutdown**: dokončí aktuální tool call, commitne
  rozdělanou práci, pošle `task.failed` s `reason="cancelled"`. Pokud
  graceful nestihne 30 s, Member **abortuje agent loop uvnitř procesu**
  (zruší pending tool call, přeskočí commit, hned pošle `task.failed`).
  Proces Memberu běží dál a čeká na další úkol — žádný `process.exit`,
  žádný container restart.
