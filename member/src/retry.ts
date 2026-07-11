/**
 * Retry helper for transient failures in outbound API/network calls.
 *
 * Scope is deliberately narrow: short, in-task retries with exponential
 * backoff to absorb the kind of "GitHub returned 502 for two seconds"
 * blips that would otherwise surface as a failed task overnight. Real
 * outages (>~30 s) blow through the retry budget and the task fails as
 * before — task-level requeue is the dispatcher's job, not ours.
 *
 * Usage:
 *
 *   const result = await retryWithBackoff(
 *     () => runGh([...]),
 *     {
 *       isTransient: (r) => !r.ok && isTransientGhError(r.err),
 *       onRetry: (attempt, delayMs) => emit('log', { ... }),
 *     },
 *   )
 */

export interface RetryPolicy<T> {
	/**
	 * Decide whether a result is "transient" and worth retrying. Operations
	 * that return errors via a result object (rather than throwing) inspect
	 * the result here. If omitted, only thrown errors are retried.
	 */
	isTransient?: (result: T) => boolean
	/**
	 * Decide whether a thrown error is transient. If omitted, all thrown
	 * errors are treated as transient (typical for `fetch` / network calls
	 * that throw on connection failure).
	 */
	isTransientError?: (err: unknown) => boolean
	/**
	 * Backoff delays in ms before each retry. Length determines max total
	 * attempts: `delays.length + 1` (the initial call plus one retry per
	 * delay). Default: `[2_000, 8_000, 30_000]` → 4 attempts, ~40s total.
	 */
	delays?: readonly number[]
	/** Notification hook fired before each retry; informational only. */
	onRetry?: (attempt: number, delayMs: number, info: { error?: unknown; result?: T }) => void
	/**
	 * Random jitter as a fraction of the delay (0–1). Default 0.25 → ±25%.
	 * Spreads out retries from many concurrent callers so a recovering API
	 * doesn't get a thundering herd at exactly +2s.
	 */
	jitter?: number
	/**
	 * When provided, an abort (task cancel / wallclock) cuts a pending backoff
	 * sleep short and rejects, instead of leaving a cancelled task idling in a
	 * 30s sleep.
	 */
	signal?: AbortSignal | undefined
}

const DEFAULT_DELAYS = [2_000, 8_000, 30_000] as const

export async function retryWithBackoff<T>(
	op: () => Promise<T>,
	policy: RetryPolicy<T> = {},
): Promise<T> {
	const delays = policy.delays ?? DEFAULT_DELAYS
	const jitter = policy.jitter ?? 0.25
	const maxAttempts = delays.length + 1

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = await op()
			if (attempt < maxAttempts && policy.isTransient?.(result)) {
				const delay = jitterMs(delays[attempt - 1]!, jitter)
				policy.onRetry?.(attempt, delay, { result })
				await sleep(delay, policy.signal)
				continue
			}
			return result
		} catch (err) {
			const transient = policy.isTransientError ? policy.isTransientError(err) : true
			if (attempt >= maxAttempts || !transient) throw err
			const delay = jitterMs(delays[attempt - 1]!, jitter)
			policy.onRetry?.(attempt, delay, { error: err })
			await sleep(delay, policy.signal)
		}
	}
	// Unreachable: the loop always returns or throws.
	throw new Error('retryWithBackoff: exhausted attempts without resolution')
}

function jitterMs(baseMs: number, fraction: number): number {
	if (fraction <= 0) return baseMs
	const span = baseMs * fraction
	return Math.max(0, Math.round(baseMs + (Math.random() * 2 - 1) * span))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason ?? new Error('aborted'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

/**
 * Heuristic classifier for `gh` CLI / git stderr that's worth retrying.
 * Matches HTTP 5xx, common transport blips, and GitHub's secondary rate
 * limit. Auth failures (401/403/404), validation errors, and merge-state
 * conflicts are non-transient by design — retrying those just delays a
 * proper failure report.
 */
export function isTransientGhError(stderr: string): boolean {
	const s = stderr.toLowerCase()
	if (/\bhttp\s*5\d\d\b/.test(s)) return true
	if (/\b(502|503|504)\b/.test(s)) return true
	if (s.includes('secondary rate limit')) return true
	if (s.includes('temporarily unavailable')) return true
	if (s.includes('connection reset')) return true
	if (s.includes('connection refused')) return true
	if (s.includes('connection timed out')) return true
	if (s.includes('i/o timeout')) return true
	if (s.includes('broken pipe')) return true
	if (/\beof\b/.test(s)) return true
	if (s.includes('no route to host')) return true
	if (s.includes('network is unreachable')) return true
	if (s.includes('etimedout')) return true
	if (s.includes('econnreset')) return true
	if (s.includes('econnrefused')) return true
	if (s.includes('enetunreach')) return true
	return false
}
