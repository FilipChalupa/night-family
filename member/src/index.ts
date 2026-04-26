import { loadConfig } from './config.ts'
import { HouseholdConnection } from './connection.ts'
import { logger } from './logger.ts'

const config = loadConfig()

logger.info(
	{
		memberId: config.memberId,
		memberName: config.memberName,
		household: config.householdUrl,
		provider: config.provider,
		model: config.model,
		skills: config.skills,
		profile: config.workerProfile,
	},
	'member starting',
)

const conn = new HouseholdConnection(config, logger.child({ component: 'connection' }))

const shutdown = (signal: string) => {
	logger.info({ signal }, 'shutting down')
	conn.stop()
	setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

conn.run().catch((err) => {
	logger.error({ err }, 'connection loop crashed')
	process.exit(1)
})
