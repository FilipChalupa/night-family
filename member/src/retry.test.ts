import { describe, expect, it, vi } from 'vitest'
import { isTransientGhError, retryWithBackoff } from './retry.ts'

describe('retryWithBackoff — result-based retries', () => {
	it('returns the first success without sleeping', async () => {
		const op = vi.fn().mockResolvedValue({ ok: true })
		const result = await retryWithBackoff(op, { delays: [10, 20] })
		expect(result).toEqual({ ok: true })
		expect(op).toHaveBeenCalledTimes(1)
	})

	it('retries when isTransient flags the result, then succeeds', async () => {
		let calls = 0
		const op = async () => {
			calls += 1
			return calls < 3 ? { ok: false, code: 502 } : { ok: true, code: 200 }
		}
		const onRetry = vi.fn()
		const result = await retryWithBackoff(op, {
			delays: [1, 1],
			isTransient: (r) => 'code' in r && r.code === 502,
			onRetry,
			jitter: 0,
		})
		expect(result).toEqual({ ok: true, code: 200 })
		expect(calls).toBe(3)
		expect(onRetry).toHaveBeenCalledTimes(2)
		expect(onRetry).toHaveBeenNthCalledWith(
			1,
			1,
			1,
			expect.objectContaining({ result: { ok: false, code: 502 } }),
		)
	})

	it('returns the last result when retries are exhausted', async () => {
		const op = vi.fn().mockResolvedValue({ ok: false, code: 502 })
		const result = await retryWithBackoff(op, {
			delays: [1, 1],
			isTransient: () => true,
			jitter: 0,
		})
		expect(result).toEqual({ ok: false, code: 502 })
		expect(op).toHaveBeenCalledTimes(3)
	})

	it('does not retry when isTransient returns false', async () => {
		type R = { ok: boolean; code: number }
		const op = vi.fn<() => Promise<R>>().mockResolvedValue({ ok: false, code: 401 })
		const result = await retryWithBackoff(op, {
			delays: [1, 1],
			isTransient: (r) => r.code === 502,
		})
		expect(result).toEqual({ ok: false, code: 401 })
		expect(op).toHaveBeenCalledTimes(1)
	})
})

describe('retryWithBackoff — thrown errors', () => {
	it('retries on every thrown error by default', async () => {
		let calls = 0
		const op = async () => {
			calls += 1
			if (calls < 3) throw new Error('boom')
			return 'ok'
		}
		const result = await retryWithBackoff(op, { delays: [1, 1], jitter: 0 })
		expect(result).toBe('ok')
		expect(calls).toBe(3)
	})

	it('rethrows immediately when isTransientError returns false', async () => {
		const err = new Error('auth')
		const op = vi.fn().mockRejectedValue(err)
		await expect(
			retryWithBackoff(op, {
				delays: [1, 1],
				isTransientError: () => false,
			}),
		).rejects.toBe(err)
		expect(op).toHaveBeenCalledTimes(1)
	})

	it('rethrows after exhausting retries', async () => {
		const err = new Error('boom')
		const op = vi.fn().mockRejectedValue(err)
		await expect(retryWithBackoff(op, { delays: [1, 1], jitter: 0 })).rejects.toBe(err)
		expect(op).toHaveBeenCalledTimes(3)
	})

	it('cuts a pending backoff short when the signal aborts', async () => {
		const ac = new AbortController()
		const op = vi.fn(async () => {
			throw new Error('boom')
		})
		// Long backoff; abort mid-wait so the retry loop rejects promptly instead
		// of sleeping the full delay.
		const p = retryWithBackoff(op, {
			delays: [60_000, 60_000],
			jitter: 0,
			signal: ac.signal,
		})
		queueMicrotask(() => ac.abort())
		await expect(p).rejects.toThrow(/aborted|abort/i)
		// Only the initial attempt ran — the abort happened during the first backoff.
		expect(op).toHaveBeenCalledTimes(1)
	})

	it('rejects immediately when the signal is already aborted before a backoff', async () => {
		const ac = new AbortController()
		ac.abort()
		const op = vi.fn(async () => {
			throw new Error('boom')
		})
		await expect(
			retryWithBackoff(op, { delays: [60_000], jitter: 0, signal: ac.signal }),
		).rejects.toBeDefined()
		expect(op).toHaveBeenCalledTimes(1)
	})
})

describe('isTransientGhError', () => {
	it.each([
		'HTTP 502 Bad Gateway',
		'HTTP 503 Service Unavailable',
		'HTTP 504 Gateway Timeout',
		'You have exceeded a secondary rate limit. Please wait a few minutes',
		'remote: 502',
		'connection reset by peer',
		'connection refused',
		'i/o timeout',
		'broken pipe while writing',
		'unexpected EOF',
		'no route to host',
		'network is unreachable',
		'dial tcp: ETIMEDOUT',
		'ECONNRESET on socket',
	])('flags %j as transient', (stderr) => {
		expect(isTransientGhError(stderr)).toBe(true)
	})

	it.each([
		'HTTP 401: Bad credentials',
		'HTTP 403: forbidden',
		'HTTP 404: not found',
		'fatal: not a git repository',
		'pathspec did not match any file',
		'A pull request already exists for branch foo',
		'Validation Failed',
		'',
	])('does not flag %j', (stderr) => {
		expect(isTransientGhError(stderr)).toBe(false)
	})
})
