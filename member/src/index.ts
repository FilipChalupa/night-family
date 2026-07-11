import { loadConfig } from './config.ts'
import { HouseholdConnection } from './connection.ts'
import { logger } from './logger.ts'
import { McpManager } from './agent/mcp.ts'
import { resolveMcpConfig } from './agent/mcp-config.ts'
import { createProvider, DailyUsageTracker, TaskRunner } from './tasks/runner.ts'
import { gcStaleCaches, gcStaleTaskDirs } from './tasks/workspace.ts'
import { killAllPreviewsNow } from './tasks/preview.ts'
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

// Connect MCP servers (resolved from mcp.yaml) at startup and keep them alive.
// A missing config file means no MCP; a server that fails to connect is left
// `down` and retried, so this never blocks the Member from running tasks.
const mcpResolved = resolveMcpConfig()
const mcpManager = new McpManager(mcpResolved.config.servers, logger.child({ component: 'mcp' }))
if (mcpManager.configured) {
	logger.info(
		{ source: mcpResolved.source, servers: mcpResolved.config.servers.map((s) => s.name) },
		'mcp config loaded',
	)
	await mcpManager.start().catch((err) => {
		logger.warn({ err }, 'mcp start failed (non-fatal)')
	})
}

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
	rebaseVerifyCommand: config.rebaseVerifyCommand,
	preview: config.preview,
	previewWaker,
	mcp: {
		tools: () => mcpManager.tools,
		serverNames: () => mcpManager.connectedServers,
	},
})

connection = new HouseholdConnection(config, logger.child({ component: 'connection' }), {
	taskRunner,
	getMcpServers: () => mcpManager.serverInfos,
})

// Push live MCP status changes (a server dropped or reconnected) to Household
// between handshakes, mirroring how `member.repos` keeps the allowlist fresh.
mcpManager.setOnChange((servers) => {
	connection?.send({ type: 'member.mcp', servers })
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

const DRAIN_MS = 8000
let shuttingDown = false
const shutdown = async (signal: string) => {
	if (shuttingDown) return
	shuttingDown = true
	logger.info({ signal }, 'shutting down')
	previewTunnel?.stop()
	// Hard-kill backstop in case draining/cleanup hangs.
	setTimeout(() => process.exit(0), DRAIN_MS + 2000).unref()
	// Cancel the in-flight task and wait (bounded) for its git/worktree/preview
	// cleanup to finish with the socket open, then the close requeues it on the
	// Household with no retry cost.
	try {
		await (connection?.drain(DRAIN_MS) ?? Promise.resolve())
	} catch (err) {
		logger.warn({ err }, 'drain failed during shutdown')
	}
	void mcpManager.close()
	// Backstop: force-kill any detached preview process groups the drain didn't
	// already stop (killTree escalates to SIGKILL only after 5s).
	killAllPreviewsNow()
	process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

connection.run().catch((err) => {
	logger.error({ err }, 'connection loop crashed')
	process.exit(1)
})
