import { loadConfig } from './config.ts'
import { HouseholdConnection } from './connection.ts'
import { logger } from './logger.ts'
import { createProvider, DailyUsageTracker, TaskRunner } from './tasks/runner.ts'
import { gcStaleCaches, gcStaleTaskDirs } from './tasks/workspace.ts'
import { PreviewTunnel } from './tasks/preview-tunnel.ts'
import { PreviewWaker } from './tasks/preview-waker.ts'
import type { MsgEvent } from '@night/shared'

const config = await loadConfig()

logger.info(
	{
		memberId: config.memberId,
		memberName: config.memberName,
		displayName: config.displayName,
		household: config.householdUrl,
		provider: config.provider,
		model: config.model,
		skills: config.skills,
		schedule: {
			source: config.scheduleSource ?? 'built-in',
			timezone: config.schedule.timezone,
			nightWindows: config.schedule.nightWindows.map((w) => w.name),
		},
		profile: config.workerProfile,
		limits: config.limits,
	},
	'member starting',
)

const gcLogger = logger.child({ component: 'gc' })
await gcStaleCaches(config.workspaceDir, gcLogger).catch((err) => {
	logger.warn({ err }, 'cache gc failed (non-fatal)')
})
await gcStaleTaskDirs(config.workspaceDir, gcLogger).catch((err) => {
	logger.warn({ err }, 'task-dir gc failed (non-fatal)')
})

// `fake` API key keeps the LLM offline and uses the StubProvider, which
// exercises the full pipeline (workspace, events, commit, push) without
// burning tokens. Real keys go through the Anthropic adapter.
const stubMode = config.aiApiKey === 'fake' || config.aiApiKey === 'stub'
const provider = createProvider({
	provider: config.provider,
	model: config.model,
	apiKey: config.aiApiKey,
	stub: stubMode,
})

if (stubMode) {
	logger.info({ provider: config.provider, model: config.model }, 'stub provider — no LLM calls')
}

let connection: HouseholdConnection | null = null

const usageTracker = new DailyUsageTracker()

// Shared between the runner (which registers a running preview) and the tunnel
// (which wakes it on a request), so an idle preview can sleep and lazily wake.
const previewWaker = new PreviewWaker()

const taskRunner = new TaskRunner({
	memberName: config.memberName,
	memberId: config.memberId,
	householdUrl: config.householdUrl,
	provider,
	limits: config.limits,
	dailyUsage: usageTracker,
	workspaceDir: config.workspaceDir,
	logger: logger.child({ component: 'runner' }),
	wsSend: (msg: MsgEvent) => connection?.send(msg) ?? false,
	stubMode,
	preview: config.preview,
	previewWaker,
})

connection = new HouseholdConnection(config, logger.child({ component: 'connection' }), {
	taskRunner,
})

// Preview members open a second, dedicated tunnel WS so Household can proxy
// inbound preview HTTP to their local dev servers (NAT-friendly: Member-opened).
const previewTunnel = config.skills.includes('preview')
	? new PreviewTunnel({
			householdUrl: config.householdUrl,
			accessToken: config.householdAccessToken,
			getSessionId: () => connection?.sessionId ?? null,
			waker: previewWaker,
			logger: logger.child({ component: 'preview-tunnel' }),
		})
	: null
if (previewTunnel) {
	previewTunnel.run().catch((err) => {
		logger.error({ err }, 'preview tunnel loop crashed')
	})
}

const shutdown = (signal: string) => {
	logger.info({ signal }, 'shutting down')
	connection?.stop()
	previewTunnel?.stop()
	setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

connection.run().catch((err) => {
	logger.error({ err }, 'connection loop crashed')
	process.exit(1)
})
