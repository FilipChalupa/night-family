import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import type { RunningPreview } from './preview.ts'
import { PreviewWaker, SleepablePreview } from './preview-waker.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as Logger

const fakePreview = (stop = vi.fn(async () => {})): RunningPreview => ({
	url: 'http://localhost:4321',
	port: 4321,
	pid: 1,
	command: 'npm run dev',
	stop,
})

describe('SleepablePreview', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('sleeps after the idle window and wakes (without re-install) on demand', async () => {
		const initial = fakePreview()
		const woke = fakePreview()
		const start = vi.fn(async () => woke)
		const s = new SleepablePreview({ initial, start, idleMs: 1000, logger: silentLogger })

		await vi.advanceTimersByTimeAsync(1000)
		expect(initial.stop).toHaveBeenCalledTimes(1)

		await s.ensureAwake()
		expect(start).toHaveBeenCalledTimes(1)

		await s.dispose()
		expect(woke.stop).toHaveBeenCalledTimes(1)
	})

	it('never sleeps when idleMs is 0', async () => {
		const initial = fakePreview()
		const s = new SleepablePreview({ initial, start: vi.fn(), idleMs: 0, logger: silentLogger })
		await vi.advanceTimersByTimeAsync(100_000)
		expect(initial.stop).not.toHaveBeenCalled()
		await s.dispose()
	})

	it('touch resets the idle timer', async () => {
		const initial = fakePreview()
		const s = new SleepablePreview({
			initial,
			start: vi.fn(),
			idleMs: 1000,
			logger: silentLogger,
		})
		await vi.advanceTimersByTimeAsync(600)
		s.touch()
		await vi.advanceTimersByTimeAsync(600) // 600 since the reset → not yet
		expect(initial.stop).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(400) // 1000 since the reset → sleeps
		expect(initial.stop).toHaveBeenCalledTimes(1)
		await s.dispose()
	})

	it('ensureAwake on an already-running preview does not restart it', async () => {
		const start = vi.fn()
		const s = new SleepablePreview({
			initial: fakePreview(),
			start,
			idleMs: 0,
			logger: silentLogger,
		})
		await s.ensureAwake()
		expect(start).not.toHaveBeenCalled()
		await s.dispose()
	})
})

describe('PreviewWaker', () => {
	it('routes ensureAwake/touch by port and is a no-op for unknown ports', async () => {
		const w = new PreviewWaker()
		const handle = { ensureAwake: vi.fn(async () => {}), touch: vi.fn() }
		w.register(3000, handle)

		await w.ensureAwake(3000)
		w.touch(3000)
		expect(handle.ensureAwake).toHaveBeenCalledTimes(1)
		expect(handle.touch).toHaveBeenCalledTimes(1)

		await expect(w.ensureAwake(9999)).resolves.toBeUndefined() // unknown port → no throw

		w.unregister(3000)
		await w.ensureAwake(3000)
		expect(handle.ensureAwake).toHaveBeenCalledTimes(1) // not called again
	})
})
