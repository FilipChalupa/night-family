import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { mountNotificationsApi } from './notifications/api.ts'
import { NotificationSender } from './notifications/sender.ts'
import { NotificationStore } from './notifications/store.ts'
import { mountStaticUi } from './static.ts'
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

const registry = new MemberRegistry()
const tokens = new TokenStore(join(config.configDir, 'tokens.yaml'))
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
	bindings: repoBindings,
	notifSender,
	logger: logger.child({ component: 'dispatcher' }),
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
	return c.json({ members: registry.list() })
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
	guard,
	logger: logger.child({ component: 'tasks.api' }),
})

mountRepoBindingsApi(app, { bindings: repoBindings, guard })
mountTokensApi(app, { tokens, guard, notifSender })
mountNotificationsApi(app, { store: notifStore, sender: notifSender, guard })
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
