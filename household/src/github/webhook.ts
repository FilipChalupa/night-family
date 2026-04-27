/**
 * GitHub webhook receiver.
 *
 *   - HMAC SHA-256 over raw body, validated against per-repo secret.
 *   - Idempotency via X-GitHub-Delivery (primary key in webhook_deliveries).
 *   - Routed to handler functions per `X-GitHub-Event`.
 *
 * Plan §3 / §7: invalid signature = 401, no audit; replays are silently
 * ack'd 200.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Db } from '../db/index.ts'
import { webhookDeliveries } from '../db/schema.ts'
import type { Dispatcher } from '../tasks/dispatcher.ts'
import type { TaskStore } from '../tasks/store.ts'
import type { RepoBindingStore } from './bindings.ts'
import { handleIssuesEvent } from './handlers/issues.ts'
import { handlePullRequestEvent, handlePullRequestReviewEvent } from './handlers/pulls.ts'
import type { ConnectedMember, MemberRegistry } from '../members/registry.ts'
import type { NotificationSender } from '../notifications/sender.ts'

export interface WebhookDeps {
	db: Db
	bindings: RepoBindingStore
	taskStore: TaskStore
	dispatcher: Dispatcher
	registry: MemberRegistry
	notifSender?: NotificationSender
	logger: Logger
}

export function mountGithubWebhook(app: Hono, deps: WebhookDeps): void {
	app.post('/webhooks/github', async (c) => {
		const event = c.req.header('x-github-event')
		const delivery = c.req.header('x-github-delivery')
		const signature = c.req.header('x-hub-signature-256') ?? ''

		if (!event || !delivery) {
			return c.json({ error: 'missing_headers' }, 400)
		}

		const rawBody = await c.req.text()

		// Parse minimally to find the repo (need it to look up the secret).
		let parsed: { repository?: { full_name?: string } } | null
		try {
			parsed = JSON.parse(rawBody) as typeof parsed
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		const repo = parsed?.repository?.full_name
		if (!repo) {
			return c.json({ error: 'missing_repository' }, 400)
		}

		const secret = deps.bindings.getWebhookSecret(repo)
		if (!secret) {
			deps.logger.warn({ repo, delivery, event }, 'no binding for repo, rejecting')
			return c.json({ error: 'unknown_repo' }, 401)
		}
		if (!verifyHmac(rawBody, signature, secret)) {
			deps.logger.warn({ repo, delivery, event }, 'invalid HMAC signature')
			return c.json({ error: 'bad_signature' }, 401)
		}

		// Idempotency. The PRIMARY KEY constraint on `id` is the source of
		// truth — INSERT OR IGNORE means replays silently 200.
		const inserted = deps.db
			.insert(webhookDeliveries)
			.values({ id: delivery, repo, event })
			.onConflictDoNothing()
			.run()

		if (inserted.changes === 0) {
			deps.logger.info({ repo, delivery, event }, 'duplicate webhook delivery — ignoring')
			return c.json({ ok: true, dedup: true })
		}

		try {
			await routeEvent(event, parsed as Record<string, unknown>, repo, deps)
			deps.db
				.update(webhookDeliveries)
				.set({ processedAt: new Date() })
				.where(eq(webhookDeliveries.id, delivery))
				.run()
			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			deps.logger.error({ err, repo, delivery, event }, 'webhook handler failed')
			deps.db
				.update(webhookDeliveries)
				.set({ error: message })
				.where(eq(webhookDeliveries.id, delivery))
				.run()
			return c.json({ error: 'handler_failed' }, 500)
		}
	})
}

async function routeEvent(
	event: string,
	body: Record<string, unknown>,
	repo: string,
	deps: WebhookDeps,
): Promise<void> {
	switch (event) {
		case 'issues':
			await handleIssuesEvent({ ...deps, repo, body })
			break
		case 'pull_request':
			await handlePullRequestEvent({
				...deps,
				repo,
				body,
				sendCancel: makeSendCancel(deps),
				notifSender: deps.notifSender,
			})
			break
		case 'pull_request_review':
			await handlePullRequestReviewEvent({
				...deps,
				repo,
				body,
				sendCancel: makeSendCancel(deps),
				notifSender: deps.notifSender,
			})
			break
		case 'ping':
			deps.logger.info({ repo }, 'webhook ping')
			break
		default:
			deps.logger.debug({ event }, 'webhook event ignored')
	}
}

function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
	if (!signature.startsWith('sha256=')) return false
	const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
	if (signature.length !== expected.length) return false
	try {
		return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	} catch {
		return false
	}
}

function makeSendCancel(
	deps: WebhookDeps,
): (sessionId: string, taskId: string, reason: string) => void {
	return (sessionId: string, taskId: string, reason: string) => {
		const conn: ConnectedMember | undefined = deps.registry.get(sessionId)
		if (!conn) return
		conn.send({ type: 'task.cancel', task_id: taskId, reason })
	}
}

/**
 * Helper for tests / smee replay — compute the expected signature for a body.
 */
export function signWebhookBody(body: string, secret: string): string {
	return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}
