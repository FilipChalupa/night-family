import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

/**
 * Tasks — one row per Night Family task. PR/review jobs are tracked
 * separately in `task_jobs` so a single task can have multiple parallel
 * review jobs (per plan §6).
 */
export const tasks = sqliteTable(
	'tasks',
	{
		id: text('id').primaryKey(),
		repo: text('repo'), // org/name; null for non-repo tasks (summarize)
		kind: text('kind').notNull(), // estimate | implement | review | respond | summarize
		title: text('title').notNull(),
		description: text('description').notNull(),
		status: text('status').notNull(), // see TaskStatus enum in shared/protocol
		estimateSize: text('estimate_size'), // S | M | L | XL
		estimateBlockers: text('estimate_blockers'), // JSON array
		prUrl: text('pr_url'),
		assignedSessionId: text('assigned_session_id'),
		assignedMemberId: text('assigned_member_id'),
		assignedMemberName: text('assigned_member_name'),
		failureReason: text('failure_reason'),
		retryCount: integer('retry_count').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		nextRetryAt: integer('next_retry_at', { mode: 'timestamp_ms' }),
		metadata: text('metadata'), // free-form JSON
	},
	(table) => ({
		statusIdx: index('tasks_status_idx').on(table.status),
		repoIdx: index('tasks_repo_idx').on(table.repo),
	}),
)

/**
 * Task events — audit trail of everything that happened on a task. Members
 * stream events with monotonic seq; Household ack-uses by writing here.
 * Retention policy (raw eventy): 90 days, per plan §3.
 */
export const taskEvents = sqliteTable(
	'task_events',
	{
		taskId: text('task_id').notNull(),
		seq: integer('seq').notNull(),
		ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
		sessionId: text('session_id'),
		memberId: text('member_id'),
		kind: text('kind').notNull(), // tool_call | file_edited | commit | usage | log | rebase
		payload: text('payload').notNull(), // JSON
	},
	(table) => ({
		pk: primaryKey({ columns: [table.taskId, table.seq] }),
		tsIdx: index('task_events_ts_idx').on(table.ts),
	}),
)

/**
 * Webhook deliveries — idempotency for GitHub webhooks (X-GitHub-Delivery).
 */
export const webhookDeliveries = sqliteTable('webhook_deliveries', {
	id: text('id').primaryKey(), // X-GitHub-Delivery uuid
	repo: text('repo').notNull(),
	event: text('event').notNull(), // X-GitHub-Event
	receivedAt: integer('received_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
	error: text('error'),
})

/**
 * Sessions — server-side session store for GitHub OAuth web UI auth.
 * TTL 30 days with rolling refresh.
 */
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	githubUsername: text('github_username').notNull(),
	role: text('role').notNull(), // admin | readonly
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	csrfToken: text('csrf_token').notNull(),
})

/**
 * OAuth login states — short-lived nonce store for GitHub OAuth flow.
 */
export const oauthStates = sqliteTable('oauth_states', {
	state: text('state').primaryKey(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	redirectTo: text('redirect_to'),
})

/**
 * Task jobs — parallel review (or future job types) dispatched for a single
 * parent task. One implement task → N concurrent review jobs per plan §6.
 */
export const taskJobs = sqliteTable(
	'task_jobs',
	{
		id: text('id').primaryKey(),
		taskId: text('task_id').notNull(),
		kind: text('kind').notNull().default('review'),
		status: text('status').notNull(), // pending | assigned | in-progress | completed | failed
		assignedSessionId: text('assigned_session_id'),
		assignedMemberId: text('assigned_member_id'),
		assignedMemberName: text('assigned_member_name'),
		verdict: text('verdict'), // approved | changes_requested | commented
		result: text('result'), // JSON
		failureReason: text('failure_reason'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		taskIdx: index('task_jobs_task_idx').on(table.taskId),
		statusIdx: index('task_jobs_status_idx').on(table.status),
	}),
)

/**
 * Notification delivery log — failed sends sit here with a Retry button
 * in the UI (per plan §3 notifications).
 */
export const notificationDeliveries = sqliteTable('notification_deliveries', {
	id: text('id').primaryKey(),
	channelId: text('channel_id').notNull(),
	event: text('event').notNull(),
	payload: text('payload').notNull(),
	status: text('status').notNull(), // sent | failed
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
})

/**
 * Repo bindings — per-repo config (webhook secret, dispatch policy, …).
 * Encrypted secrets via SECRETS_KEY (impl lands in M7).
 */
export const repoBindings = sqliteTable('repo_bindings', {
	repo: text('repo').primaryKey(), // org/name
	webhookSecretEnc: text('webhook_secret_enc').notNull(),
	githubPatEnc: text('github_pat_enc'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
})

/**
 * Notification channels — outbound webhook URLs / SMTP. Encrypted secrets
 * (URL with auth, SMTP creds) via SECRETS_KEY.
 */
export const notificationChannels = sqliteTable('notification_channels', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	kind: text('kind').notNull(), // webhook | smtp
	configEnc: text('config_enc').notNull(),
	subscribedEvents: text('subscribed_events').notNull(), // JSON array
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
})
