import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountOAuth, mountWhoAmI } from './auth/oauth.ts'
import { SessionStore } from './auth/sessions.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { logger } from './logger.ts'
import { MemberRegistry } from './members/registry.ts'
import { mountStaticUi } from './static.ts'
import { TokenStore } from './tokens/auth.ts'
import { UserStore } from './users/store.ts'
import { createMemberWsHandler } from './ws/members.ts'
import { createUiWsHandler } from './ws/ui.ts'

const config = loadConfig()
const startedAt = Date.now()

const dbHandles = openDb(config.dataDir)
logger.info({ dataDir: config.dataDir }, 'database opened, migrations applied')

const registry = new MemberRegistry()
const tokens = new TokenStore(join(config.configDir, 'tokens.yaml'))
const users = new UserStore(join(config.configDir, 'users.yaml'), config.primaryAdminGithubUsername)
users.bootstrapPrimaryAdmin()
logger.info(
	{ primaryAdmin: config.primaryAdminGithubUsername, total: users.list().length },
	'users store ready',
)

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

app.get('/api/members', (c) => c.json({ members: registry.list() }))

const memberHandler = createMemberWsHandler({
	registry,
	tokens,
	householdName: config.householdName,
	logger: logger.child({ component: 'ws.member' }),
})

const uiHandler = createUiWsHandler({
	registry,
	logger: logger.child({ component: 'ws.ui' }),
})

app.get('/ws/member', upgradeWebSocket(memberHandler))
app.get('/ws/ui', upgradeWebSocket(uiHandler))

const sessionStore = new SessionStore(dbHandles.db)
sessionStore.purgeExpired()
setInterval(() => sessionStore.purgeExpired(), 60 * 60 * 1000).unref()

mountWhoAmI(app, {
	sessions: sessionStore,
	oauthConfigured: !!config.githubOauth,
})

if (config.githubOauth) {
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
