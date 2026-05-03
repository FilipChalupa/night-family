import { loadConfig } from './config.ts'
import { HouseholdConnection } from './connection.ts'
import { logger } from './logger.ts'
import { createProvider, DailyUsageTracker, TaskRunner } from './tasks/runner.ts'
import { gcStaleCaches } from './tasks/workspace.ts'
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
		profile: config.workerProfile,
		limits: config.limits,
	},
	'member starting',
)

await gcStaleCaches(config.workspaceDir, logger.child({ component: 'gc' })).catch((err) => {
	logger.warn({ err }, 'cache gc failed (non-fatal)')
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
})

connection = new HouseholdConnection(config, logger.child({ component: 'connection' }), {
	taskRunner,
})

const shutdown = (signal: string) => {
	logger.info({ signal }, 'shutting down')
	connection?.stop()
	setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

connection.run().catch((err) => {
	logger.error({ err }, 'connection loop crashed')
	process.exit(1)
})
