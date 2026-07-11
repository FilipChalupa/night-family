import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_SKILLS, PROTOCOL_VERSION, type Skill } from '@night/shared'
import { AdminGuard } from './auth/guard.ts'
import { mountOAuth, mountWhoAmI } from './auth/oauth.ts'
import { SessionStore } from './auth/sessions.ts'
import { loadConfig } from './config.ts'
import { SecretCipher, resolveSecretsKey } from './crypto/secrets.ts'
import { openDb } from './db/index.ts'
import { mountRepoBindingsApi } from './github/api.ts'
import { mountPreviewProxy } from './preview/proxy.ts'
import {
	PreviewActivity,
	PreviewTunnelHub,
	createPreviewTunnelHandler,
	createPreviewWsTunnelHandler,
	idlePreviewTaskIds,
	previewHostMiddleware,
} from './preview/tunnel.ts'
import { RepoBindingStore } from './github/bindings.ts'
import { sweepStalePrsForRebase } from './github/handlers/pulls.ts'
import { mountGithubWebhook } from './github/webhook.ts'
import { logger } from './logger.ts'
import { MemberRegistry } from './members/registry.ts'
import { buildMembersSnapshot, getMemberSnapshotById } from './members/snapshot.ts'
import { MemberStateStore } from './members/store.ts'
import { mountNotificationsApi } from './notifications/api.ts'
import { NotificationSender } from './notifications/sender.ts'
import { NotificationStore } from './notifications/store.ts'
import { mountPushApi } from './push/api.ts'
import { PushSender } from './push/sender.ts'
import { PushSubscriptionStore } from './push/store.ts'
import { TaskPushTransitionTracker } from './push/taskTransitions.ts'
import { loadOrGenerateVapidKeys } from './push/vapid.ts'
import { mountStaticUi } from './static.ts'
import { mountStatsApi } from './stats/api.ts'
import { mountTasksApi } from './tasks/api.ts'
import { Dispatcher } from './tasks/dispatcher.ts'
import { TaskEventLog } from './tasks/eventLog.ts'
import { TaskJobStore } from './tasks/jobStore.ts'
import { TaskStore } from './tasks/store.ts'
import { mountTokensApi } from './tokens/api.ts'
import { TokenStore } from './tokens/auth.ts'
import { mountUsersApi } from './users/api.ts'
import { UserStore } from './users/store.ts'
import { createMemberWsHandler } from './ws/members.ts'
import { createUiWsHandler } from './ws/ui.ts'

const config = loadConfig()
const startedAt = Date.now()

const dbHandles = openDb(config.dataDir)
logger.info({ dataDir: config.dataDir }, 'database opened, migrations applied')

const memberStore = new MemberStateStore(dbHandles.db)
const registry = new MemberRegistry(memberStore)
const tokens = new TokenStore(join(config.configDir, 'tokens.yaml'))

// Backfill historic first/last connect timestamps from the tokens.yaml usage
// log into the persisted members table, so members from before this table
// existed have realistic connection timeline data.
{
	const usage: Array<{ memberId: string; memberName: string; connectedAt: Date }> = []
	for (const t of tokens.list()) {
		for (const u of t.usage ?? []) {
			const d = new Date(u.connected_at)
			if (Number.isNaN(d.getTime())) continue
			usage.push({ memberId: u.member_id, memberName: u.member_name, connectedAt: d })
		}
	}
	memberStore.bootstrapFromTokenUsage(usage)
}
const users = config.primaryAdminGithubUsername
	? new UserStore(join(config.configDir, 'users.yaml'), config.primaryAdminGithubUsername)
	: null
if (users) {
	users.bootstrapPrimaryAdmin()
	logger.info(
		{ primaryAdmin: config.primaryAdminGithubUsername, total: users.list().length },
		'users store ready',
	)
}

const { value: secretsKey } = resolveSecretsKey({
	envValue: config.secretsKey,
	configDir: config.configDir,
	logger: logger.child({ component: 'secrets' }),
})
const cipher = new SecretCipher(secretsKey)

const taskStore = new TaskStore(dbHandles.db)
const jobStore = new TaskJobStore(dbHandles.db)
const eventLog = new TaskEventLog(dbHandles.db)
const repoBindings = new RepoBindingStore(dbHandles.db, cipher)
const notifStore = new NotificationStore(dbHandles.db, cipher)
const notifSender = new NotificationSender(notifStore, logger.child({ component: 'notifications' }))
const dispatcher = new Dispatcher({
	taskStore,
	jobStore,
	registry,
	notifSender,
	logger: logger.child({ component: 'dispatcher' }),
	maxReviewJobsPerTask: config.maxReviewJobsPerTask,
	selfReviewFallbackMs: config.selfReviewFallbackMs,
})

// Schedule edges (and override expirations) need to wake the dispatcher so a
// Member that was idle through the day picks up `implement` work as soon as
// the night window opens — without it, the Member would sit idle until the
// next external event happened to fire. Day↔night is also a natural moment
// to ask the Member to re-fetch its accessible repos: new collaborator
// invites granted during the day land before the first night-time `implement`
// dispatch attempt, so the allowlist is fresh by the time it matters.
registry.setOnScheduleTick((sessionId) => {
	dispatcher.requestReposRefreshForSession(sessionId, 'schedule_edge')
	const member = registry.list().find((m) => m.sessionId === sessionId)
	if (member && member.status === 'idle') dispatcher.tryDispatchOne(member)
})

// Wrap a periodic callback so a thrown error is logged instead of crashing the
// process. A `setInterval` callback has no caller to catch its throws — an
// unhandled exception in one (e.g. a transient DB error mid-purge) would
// otherwise take down the whole Household hours into a run.
const guardPeriodic = (job: string, fn: () => void) => () => {
	try {
		fn()
	} catch (err) {
		logger.error({ err, job }, 'periodic job failed')
	}
}

// Daily purge of raw event rows older than 90 days.
const purgeEvents = () => {
	const removed = eventLog.purgeOlderThan(90)
	if (removed > 0) logger.info({ removed }, 'purged stale task_events')
}
purgeEvents()
setInterval(guardPeriodic('purge_events', purgeEvents), 24 * 60 * 60 * 1000).unref()

// Freshness sweep (rebase trigger #3, time-driven). Push webhooks keep open
// PRs current as `main` advances, but they can be missed (Household down, a
// fork-side base merge, a dropped delivery). Every 6h, enqueue an idempotent
// rebase for any open PR untouched for 6h+; the active-dedup + cooldown guards
// and the Member-side no-op-when-current path keep this cheap on a quiet fleet.
const REBASE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
const REBASE_SWEEP_STALE_AFTER_MS = 6 * 60 * 60 * 1000
const sweepStaleRebases = () => {
	const enqueued = sweepStalePrsForRebase(
		{ taskStore, dispatcher, logger: logger.child({ component: 'rebase-sweep' }) },
		REBASE_SWEEP_STALE_AFTER_MS,
	)
	if (enqueued > 0) logger.info({ enqueued }, 'freshness sweep enqueued rebase task(s)')
}
setInterval(guardPeriodic('rebase_sweep', sweepStaleRebases), REBASE_SWEEP_INTERVAL_MS).unref()

// Dispatch sweep. Retry backoffs are nudged by an in-memory setTimeout, but a
// Household restart drops those timers — a queued task whose nextRetryAt has
// since passed would then wait for an unrelated member.ready/task event. A
// cheap periodic tryDispatchAll re-arms dispatch (the claim query already gates
// on nextRetryAt <= now, so nothing dispatches early).
setInterval(
	guardPeriodic('dispatch_sweep', () => dispatcher.tryDispatchAll()),
	60_000,
).unref()

const app = new Hono()

const nodeWs = createNodeWebSocket({ app })
const { upgradeWebSocket, injectWebSocket } = nodeWs
// Echo the first subprotocol a client offers back in the handshake — what
// `ws` does by default, pinned here so it's explicit and survives a default
// change. Only fires when a client actually offers one (preview HMR, e.g.
// Vite's `vite-hmr`); the member/ui control sockets offer none and are
// untouched.
nodeWs.wss.options.handleProtocols = (protocols) => protocols.values().next().value ?? false

// Preview subdomain proxy. Registered first so a `p<port>-<task>.<domain>`
// request is tunnelled to the owning Member before any normal route or the
// static UI sees it. No-op (pass-through) unless PREVIEWS_DOMAIN is set.
const previewTunnelHub = new PreviewTunnelHub(logger.child({ component: 'preview.tunnel' }))
const previewActivity = new PreviewActivity()
if (config.previewsDomain) {
	app.use(
		'*',
		previewHostMiddleware({
			hub: previewTunnelHub,
			taskStore,
			previewsDomain: config.previewsDomain,
			activity: previewActivity,
			logger: logger.child({ component: 'preview.host' }),
		}),
	)
	logger.info({ previewsDomain: config.previewsDomain }, 'preview subdomain proxy enabled')
}

app.get('/health', (c) => {
	let dbOk = false
	try {
		dbHandles.sqlite.prepare('SELECT 1').get()
		dbOk = true
	} catch {
		dbOk = false
	}
	return c.json(
		{
			status: dbOk ? 'ok' : 'degraded',
			household: config.householdName,
			uptimeSec: Math.round((Date.now() - startedAt) / 1000),
			members: registry.list().length,
			protocolVersion: PROTOCOL_VERSION,
			db: dbOk,
		},
		// A broken/locked DB must surface as unhealthy so the Docker healthcheck
		// (wget || exit 1) and depends_on: service_healthy actually trip.
		dbOk ? 200 : 503,
	)
})

const memberHandler = createMemberWsHandler({
	registry,
	tokens,
	dispatcher,
	eventLog,
	householdName: config.householdName,
	logger: logger.child({ component: 'ws.member' }),
})

const sessionStore = new SessionStore(dbHandles.db)
sessionStore.purgeExpired()
setInterval(
	guardPeriodic('session_purge', () => sessionStore.purgeExpired()),
	60 * 60 * 1000,
).unref()

const uiHandler = createUiWsHandler({
	registry,
	memberStore,
	taskStore,
	eventLog,
	sessions: sessionStore,
	requireUiLogin: config.requireUiLogin,
	logger: logger.child({ component: 'ws.ui' }),
})

app.get('/ws/member', upgradeWebSocket(memberHandler))
app.get('/ws/ui', upgradeWebSocket(uiHandler))
app.get(
	'/ws/preview',
	upgradeWebSocket(
		createPreviewTunnelHandler({
			hub: previewTunnelHub,
			tokens,
			registry,
			logger: logger.child({ component: 'ws.preview' }),
		}),
	),
)

const guard = new AdminGuard(sessionStore, config.requireUiLogin, !!config.githubOauth)

// Without OAuth configured, `requireAdmin` is a no-op — every admin mutation
// (repo bindings, notification channels incl. an arbitrary-URL POST test =
// SSRF, token issue/revoke) is open to anyone who can reach the port. Fine on a
// trusted loopback/LAN, dangerous if the port is bound to 0.0.0.0 without a
// firewall. Warn loudly so a self-hoster notices before exposing it.
if (!config.githubOauth) {
	logger.warn(
		'AUTH DISABLED: no GitHub OAuth configured — all admin endpoints are OPEN to anyone who can reach this port. ' +
			'Do NOT expose it publicly (bind to loopback/LAN or put it behind a firewall/proxy). ' +
			'Set GITHUB_OAUTH_CLIENT_ID/SECRET + PRIMARY_ADMIN_GITHUB_USERNAME to require login.',
	)
}

app.get('/api/members', (c) => {
	const guardResult = guard.requireAuthenticated(c)
	if (guardResult) return guardResult
	return c.json({ members: buildMembersSnapshot(registry, memberStore) })
})

app.get('/api/members/:memberId', (c) => {
	const guardResult = guard.requireAuthenticated(c)
	if (guardResult) return guardResult
	const member = getMemberSnapshotById(c.req.param('memberId'), registry, memberStore)
	if (!member) return c.json({ error: 'not_found' }, 404)
	return c.json({ member })
})

/**
 * Set or clear an admin override for the given member. The override is
 * Household-internal state evaluated alongside the schedule when the
 * dispatcher decides what kinds the Member can take; the Member itself
 * is never told. Idle sessions get a dispatch kick so they pick up any
 * task that became eligible.
 *
 * `skills: null` clears any active override. `duration_minutes` (1–1440)
 * defines `expires_at = now + dur` for new overrides.
 */
app.post('/api/members/:memberId/override', async (c) => {
	const guardResult = guard.requireAdmin(c)
	if (guardResult) return guardResult
	const memberId = c.req.param('memberId')
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'invalid_json' }, 400)
	}
	if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
	const b = body as Record<string, unknown>
	const sessions = registry.findByMemberId(memberId)
	if (sessions.length === 0) return c.json({ error: 'member_offline' }, 409)

	if (b.skills === null) {
		const updated = registry.setOverride(memberId, null)
		dispatcher.tryDispatchAll()
		return c.json({ ok: true, cleared: true, sessions: updated })
	}

	if (!Array.isArray(b.skills) || b.skills.length === 0) {
		return c.json({ error: 'invalid_skills' }, 400)
	}
	const rawSkills = b.skills as unknown[]
	const skills: Skill[] = []
	for (const s of rawSkills) {
		if (typeof s !== 'string' || !(ALL_SKILLS as readonly string[]).includes(s)) {
			return c.json({ error: `invalid_skill:${String(s)}` }, 400)
		}
		skills.push(s as Skill)
	}
	const dur = b.duration_minutes
	if (typeof dur !== 'number' || !Number.isFinite(dur) || dur < 1 || dur > 1440) {
		return c.json({ error: 'invalid_duration_minutes' }, 400)
	}
	const expiresAt = new Date(Date.now() + dur * 60_000)
	const updated = registry.setOverride(memberId, { skills, expiresAt })
	dispatcher.tryDispatchAll()
	return c.json({ ok: true, expires_at: expiresAt.toISOString(), sessions: updated })
})

/**
 * Manually ask a Member to re-fetch its accessible-repos list from GitHub.
 * Pushes `repos.refresh` to every live session for the member; the Member
 * replies with `member.repos` (or `member.repos_error`) which updates the
 * cached allowlist asynchronously. Returns the count of sessions pinged so
 * the UI can render "asked N sessions to refresh" feedback.
 */
app.post('/api/members/:memberId/refresh-repos', (c) => {
	const guardResult = guard.requireAdmin(c)
	if (guardResult) return guardResult
	const memberId = c.req.param('memberId')
	const sessions = registry.findByMemberId(memberId)
	if (sessions.length === 0) return c.json({ error: 'member_offline' }, 409)
	for (const s of sessions) {
		dispatcher.requestReposRefreshForSession(s.sessionId, 'manual')
	}
	return c.json({ ok: true, sessions: sessions.length })
})

mountWhoAmI(app, {
	sessions: sessionStore,
	oauthConfigured: !!config.githubOauth,
	requireUiLogin: config.requireUiLogin,
})

mountTasksApi(app, {
	taskStore,
	dispatcher,
	registry,
	eventLog,
	guard,
	logger: logger.child({ component: 'tasks.api' }),
})

mountRepoBindingsApi(app, { bindings: repoBindings, registry, guard })
mountPreviewProxy(app, { taskStore })
mountStatsApi(app, { sqlite: dbHandles.sqlite, guard, previewHub: previewTunnelHub })
mountTokensApi(app, { tokens, guard, notifSender })
mountNotificationsApi(app, { store: notifStore, sender: notifSender, guard })

// Web Push fan-out for desktop/mobile notifications when the dashboard tab
// isn't open. Subject must be a valid `mailto:` or `https:` URL per RFC 8292.
const vapidKeys = loadOrGenerateVapidKeys({
	configDir: config.configDir,
	logger: logger.child({ component: 'push.vapid' }),
})
const pushStore = new PushSubscriptionStore(dbHandles.db)
// Build a valid host label from the household name: keep [a-z0-9.-], strip
// leading/trailing separators, and fall back to a fixed label when nothing
// usable remains — otherwise an empty or all-punctuation HOUSEHOLD_NAME yields
// `mailto:noreply@.local` / `@---.local`, which web-push rejects at send time
// and breaks the whole push fan-out.
const vapidHostLabel =
	config.householdName
		.toLowerCase()
		.replace(/[^a-z0-9.-]/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '') || 'night-family'
const pushSender = new PushSender({
	store: pushStore,
	keys: vapidKeys,
	subject: `mailto:noreply@${vapidHostLabel}.local`,
	logger: logger.child({ component: 'push.sender' }),
})
mountPushApi(app, { store: pushStore, keys: vapidKeys, guard })

const pushTransitions = new TaskPushTransitionTracker({
	setLastNotifiedStatus: (taskId, status) => taskStore.setLastNotifiedStatus(taskId, status),
})
taskStore.on((event) => {
	if (event.type !== 'task.updated') return
	const payload = pushTransitions.observe(event.task)
	if (!payload) return
	pushSender.broadcast(payload).catch((err) => {
		logger.warn({ err }, 'push broadcast failed')
	})
})
if (users) {
	mountUsersApi(app, { users, guard })
}

mountGithubWebhook(app, {
	db: dbHandles.db,
	bindings: repoBindings,
	taskStore,
	dispatcher,
	registry,
	notifSender,
	logger: logger.child({ component: 'webhook' }),
})

if (config.githubOauth) {
	if (!users) throw new Error('users store unavailable despite OAuth config')
	mountOAuth(app, {
		clientId: config.githubOauth.clientId,
		clientSecret: config.githubOauth.clientSecret,
		db: dbHandles.db,
		users,
		sessions: sessionStore,
		logger: logger.child({ component: 'oauth' }),
	})
	logger.info('GitHub OAuth login enabled')
} else {
	logger.warn(
		'GitHub OAuth not configured — set GITHUB_OAUTH_CLIENT_ID/SECRET to enable web UI login',
	)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const webDistCandidates = [
	process.env['WEB_DIST_DIR'],
	join(__dirname, '..', 'web', 'dist'),
].filter((p): p is string => !!p)
// Preview HMR: bridge browser WebSocket upgrades on a preview subdomain to the
// owning Member's dev server. Catch-all, registered just before the static UI;
// it only upgrades preview-host requests and passes everything else through.
if (config.previewsDomain) {
	app.get(
		'*',
		upgradeWebSocket(
			createPreviewWsTunnelHandler({
				hub: previewTunnelHub,
				taskStore,
				previewsDomain: config.previewsDomain,
				activity: previewActivity,
				logger: logger.child({ component: 'preview.ws' }),
			}),
		),
	)
}

// Tear down previews nobody is looking at. Cancelling the task stops the dev
// server (the PR section flips to "stopped"); freeing the Member for other
// work. Disabled at TTL 0.
if (config.previewsDomain && config.previewIdleTtlMinutes > 0) {
	const idleTtlMs = config.previewIdleTtlMinutes * 60_000
	const sweepIdlePreviews = () => {
		const active = taskStore.list({ status: ['assigned', 'in-progress'] })
		previewActivity.retain(new Set(active.filter((t) => t.kind === 'preview').map((t) => t.id)))
		for (const id of idlePreviewTaskIds(active, previewActivity, idleTtlMs)) {
			const task = taskStore.get(id)
			if (!task) continue
			const conn = task.assignedSessionId
				? registry.findConnectionForTask(task.assignedSessionId, task.assignedMemberId)
				: null
			if (conn) {
				conn.send({ type: 'task.cancel', task_id: id, reason: 'preview_idle' })
			} else {
				taskStore.transition(id, [task.status], 'failed', { failureReason: 'preview_idle' })
				taskStore.clearAssignment(id)
			}
			previewActivity.forget(id)
			logger.info({ taskId: id }, 'idle preview torn down')
		}
	}
	setInterval(guardPeriodic('preview_idle_sweep', sweepIdlePreviews), 60_000).unref()
}

mountStaticUi(app, webDistCandidates, logger)

const server = serve(
	{
		fetch: app.fetch,
		port: config.port,
	},
	(info) => {
		logger.info(
			{
				household: config.householdName,
				port: info.port,
				primaryAdmin: config.primaryAdminGithubUsername,
			},
			'household listening',
		)
	},
)

injectWebSocket(server)

let shuttingDown = false
const shutdown = (signal: string, exitCode = 0) => {
	if (shuttingDown) return
	shuttingDown = true
	logger.info({ signal, exitCode }, 'shutting down')
	// Members/UI/preview hold persistent WebSockets, which keep the HTTP
	// server's connection count above zero — so server.close() would never fire
	// its callback (DB close + exit) and we'd always fall through to the
	// hard-kill timer. Close the sockets explicitly first.
	for (const client of nodeWs.wss.clients) {
		try {
			client.close(1001, 'household shutting down')
		} catch {
			// already closing/closed
		}
	}
	nodeWs.wss.close()
	server.close(() => {
		dbHandles.close()
		process.exit(exitCode)
	})
	// Drop any lingering keep-alive HTTP connections that would otherwise hold
	// the server open past the WS close.
	;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
	// Hard-kill backstop. Preserve a non-zero exit (e.g. uncaughtException) so a
	// restart-on-failure orchestrator still restarts us.
	setTimeout(() => process.exit(exitCode || 1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Last-resort safety net. A stray rejection/throw from an un-awaited promise
// would otherwise terminate the orchestrator on Node's default with no clean
// shutdown. Log it and drain gracefully so the DB is checkpointed before exit.
process.on('unhandledRejection', (reason) => {
	logger.error({ err: reason }, 'unhandled promise rejection')
})
process.on('uncaughtException', (err) => {
	logger.fatal({ err }, 'uncaught exception — shutting down')
	// Exit non-zero: the process state is undefined and a restart-on-failure
	// orchestrator should restart us rather than treat this as a clean stop.
	shutdown('uncaughtException', 1)
})
