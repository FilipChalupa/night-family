import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_SKILLS, PROTOCOL_VERSION } from '@night/shared'
import { AdminGuard } from './auth/guard.ts'
import { mountOAuth, mountWhoAmI } from './auth/oauth.ts'
import { SessionStore } from './auth/sessions.ts'
import { loadConfig } from './config.ts'
import { SecretCipher, resolveSecretsKey } from './crypto/secrets.ts'
import { openDb } from './db/index.ts'
import { mountRepoBindingsApi } from './github/api.ts'
import { RepoBindingStore } from './github/bindings.ts'
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

// Daily purge of raw event rows older than 90 days (per plan §3).
const purgeEvents = () => {
	const removed = eventLog.purgeOlderThan(90)
	if (removed > 0) logger.info({ removed }, 'purged stale task_events')
}
purgeEvents()
setInterval(purgeEvents, 24 * 60 * 60 * 1000).unref()

const app = new Hono()

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

app.get('/health', (c) => {
	let dbOk = false
	try {
		dbHandles.sqlite.prepare('SELECT 1').get()
		dbOk = true
	} catch {
		dbOk = false
	}
	return c.json({
		status: dbOk ? 'ok' : 'degraded',
		household: config.householdName,
		uptimeSec: Math.round((Date.now() - startedAt) / 1000),
		members: registry.list().length,
		protocolVersion: PROTOCOL_VERSION,
		db: dbOk,
	})
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
setInterval(() => sessionStore.purgeExpired(), 60 * 60 * 1000).unref()

const uiHandler = createUiWsHandler({
	registry,
	memberStore,
	taskStore,
	sessions: sessionStore,
	requireUiLogin: config.requireUiLogin,
	logger: logger.child({ component: 'ws.ui' }),
})

app.get('/ws/member', upgradeWebSocket(memberHandler))
app.get('/ws/ui', upgradeWebSocket(uiHandler))

const guard = new AdminGuard(sessionStore, config.requireUiLogin, !!config.githubOauth)

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
 * Push a schedule override to all connected sessions of the given member.
 * `skills: null` clears any active override. `duration_minutes` (1–1440)
 * defines `expires_at = now + dur`. The Member is responsible for
 * actually clearing the override once the timestamp passes — Household
 * just delivers and forgets.
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
		for (const s of sessions) {
			s.send({ type: 'schedule.override', skills: null, expires_at: null })
		}
		return c.json({ ok: true, cleared: true })
	}

	if (!Array.isArray(b.skills) || b.skills.length === 0) {
		return c.json({ error: 'invalid_skills' }, 400)
	}
	const skills = b.skills as string[]
	for (const s of skills) {
		if (typeof s !== 'string' || !(ALL_SKILLS as readonly string[]).includes(s)) {
			return c.json({ error: `invalid_skill:${s}` }, 400)
		}
	}
	const dur = b.duration_minutes
	if (typeof dur !== 'number' || !Number.isFinite(dur) || dur < 1 || dur > 1440) {
		return c.json({ error: 'invalid_duration_minutes' }, 400)
	}
	const expiresAt = new Date(Date.now() + dur * 60_000).toISOString()
	for (const s of sessions) {
		s.send({ type: 'schedule.override', skills, expires_at: expiresAt })
	}
	return c.json({ ok: true, expires_at: expiresAt, sessions: sessions.length })
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
mountStatsApi(app, { sqlite: dbHandles.sqlite, guard })
mountTokensApi(app, { tokens, guard, notifSender })
mountNotificationsApi(app, { store: notifStore, sender: notifSender, guard })

// Web Push fan-out for desktop/mobile notifications when the dashboard tab
// isn't open. Subject must be a valid `mailto:` or `https:` URL per RFC 8292.
const vapidKeys = loadOrGenerateVapidKeys({
	configDir: config.configDir,
	logger: logger.child({ component: 'push.vapid' }),
})
const pushStore = new PushSubscriptionStore(dbHandles.db)
const pushSender = new PushSender({
	store: pushStore,
	keys: vapidKeys,
	subject: `mailto:noreply@${config.householdName.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}.local`,
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

const shutdown = (signal: string) => {
	logger.info({ signal }, 'shutting down')
	server.close(() => {
		dbHandles.close()
		process.exit(0)
	})
	setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
