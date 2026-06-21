import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

/**
 * Members — canonical record per known Member (keyed by member_id, the UUID a
 * Member generates and reuses across reconnects). Holds the latest snapshot
 * of identity/skills/profile metadata plus connection-lifecycle timestamps.
 *
 * Rows are never deleted: they outlive any individual session and are the FK
 * target for `tasks.assigned_member_id`, `task_events.member_id`, and
 * `task_jobs.assigned_member_id`. Disconnected members can be surfaced by the
 * UI for as long as `last_seen_at` is fresh enough.
 */
export const members = sqliteTable(
	'members',
	{
		memberId: text('member_id').primaryKey(),
		memberName: text('member_name').notNull(),
		displayName: text('display_name').notNull(),
		skills: text('skills').notNull().default('[]'), // JSON array
		repos: text('repos'), // JSON array; null = unconstrained
		provider: text('provider').notNull().default(''),
		model: text('model').notNull().default(''),
		workerProfile: text('worker_profile').notNull().default(''),
		protocolVersion: text('protocol_version').notNull().default(''),
		tokenId: text('token_id'),
		firstConnectedAt: integer('first_connected_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastConnectedAt: integer('last_connected_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastDisconnectedAt: integer('last_disconnected_at', { mode: 'timestamp_ms' }),
	},
	(table) => ({
		lastSeenIdx: index('members_last_seen_idx').on(table.lastSeenAt),
	}),
)

/**
 * Tasks — one row per Night Family task. PR/review jobs are tracked
 * separately in `task_jobs` so a single task can have multiple parallel
 * review jobs.
 */
export const tasks = sqliteTable(
	'tasks',
	{
		id: text('id').primaryKey(),
		repo: text('repo'), // org/name; null for non-repo tasks (summarize)
		kind: text('kind').notNull(), // implement | review | triage | respond | summarize | rebase
		title: text('title').notNull(),
		description: text('description').notNull(),
		status: text('status').notNull(), // see TaskStatus enum in shared/protocol
		// Plan size set by triage's plan-outcome JSON; consumed by the implement
		// task spawned from triage. Also patchable by admins via PATCH /api/tasks/:id.
		planSize: text('plan_size'), // S | M | L | XL
		planBlockers: text('plan_blockers'), // JSON array
		prUrl: text('pr_url'),
		assignedSessionId: text('assigned_session_id'),
		/**
		 * The Member currently working on this task. Set when the task is
		 * claimed (`queued → assigned`); cleared on `clearAssignment` after
		 * completion / failure. May be null for queued tasks that have never
		 * been claimed.
		 */
		assignedMemberId: text('assigned_member_id').references(() => members.memberId, {
			onDelete: 'set null',
		}),
		/**
		 * Hint for the dispatcher: when a task returns to `queued` after a
		 * `changes_requested` review or an auto-retry, this stores who
		 * implemented it last so the dispatcher can give that Member first
		 * dibs (warm workspace + warm prompt cache). Independent of
		 * `assignedMemberId` so the active-vs-preferred semantics don't get
		 * tangled.
		 */
		previousMemberId: text('previous_member_id').references(() => members.memberId, {
			onDelete: 'set null',
		}),
		/**
		 * GitHub login of the original PR author at the time the PR was
		 * opened. Used by the review dispatcher to identify self-review even
		 * after a `changes_requested` cycle reassigns the task to a different
		 * Member. Persists once set.
		 */
		prAuthorLogin: text('pr_author_login'),
		/** Last `status` value we fired a push notification for. Prevents
		 * double-fires after a Household restart and lets the tracker stay
		 * idempotent. Updated by the push tracker as it observes transitions. */
		lastNotifiedStatus: text('last_notified_status'),
		/** Indexed lookup for `issue_comment` / `issues` webhooks. */
		githubIssueNumber: integer('github_issue_number'),
		/** Convenience copy of the issue URL, alongside `githubIssueNumber`. */
		githubIssueUrl: text('github_issue_url'),
		failureReason: text('failure_reason'),
		retryCount: integer('retry_count').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		nextRetryAt: integer('next_retry_at', { mode: 'timestamp_ms' }),
		metadata: text('metadata'), // free-form JSON for any other per-task data
	},
	(table) => ({
		statusIdx: index('tasks_status_idx').on(table.status),
		repoIdx: index('tasks_repo_idx').on(table.repo),
		prUrlIdx: index('tasks_pr_url_idx').on(table.prUrl),
		issueIdx: index('tasks_issue_idx').on(table.repo, table.githubIssueNumber),
	}),
)

/**
 * Task events — audit trail of everything that happened on a task. Members
 * stream events with monotonic seq; Household ack-uses by writing here.
 * Retention policy (raw events): 90 days.
 */
export const taskEvents = sqliteTable(
	'task_events',
	{
		taskId: text('task_id').notNull(),
		seq: integer('seq').notNull(),
		ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
		sessionId: text('session_id'),
		memberId: text('member_id').references(() => members.memberId, { onDelete: 'set null' }),
		kind: text('kind').notNull(), // tool_call | file_edited | commit | usage | log | rebase | preview
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
 * parent task. One implement task → N concurrent review jobs.
 */
export const taskJobs = sqliteTable(
	'task_jobs',
	{
		id: text('id').primaryKey(),
		taskId: text('task_id').notNull(),
		status: text('status').notNull(), // pending | assigned | in-progress | completed | failed
		assignedSessionId: text('assigned_session_id'),
		assignedMemberId: text('assigned_member_id').references(() => members.memberId, {
			onDelete: 'set null',
		}),
		prAuthorLogin: text('pr_author_login'), // GitHub login of the PR author at job-creation time
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
 * in the UI.
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

/**
 * Web Push subscriptions — one row per browser that opted in. We fan out to
 * every active subscription on task notifications; the browser endpoint is
 * the unique identity, and `userLogin` is recorded purely for audit/debug.
 *
 * 410 Gone responses from the push service mean the subscription is dead;
 * the push sender deletes those rows on the fly.
 */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
	id: text('id').primaryKey(),
	userLogin: text('user_login').notNull(),
	endpoint: text('endpoint').notNull().unique(),
	p256dh: text('p256dh').notNull(),
	auth: text('auth').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
})
