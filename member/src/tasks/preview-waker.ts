/**
 * In-process bridge between the preview tunnel and the running preview, so an
 * idle preview can sleep (dev-server process stopped, checkout kept warm) and
 * wake lazily on the next request — no manual restart.
 *
 *   - {@link SleepablePreview} owns the dev-server process: it arms an idle
 *     timer that sleeps the process, and `ensureAwake()` (re)starts it.
 *   - {@link PreviewWaker} maps the ports a preview exposes to its handle, so
 *     the tunnel (which only knows the port a request targets) can wake/touch
 *     it before proxying.
 *
 * Both live in the Member process: `runPreview` registers a handle; the
 * `PreviewTunnel` consumes it.
 */

import type { Logger } from 'pino'
import type { RunningPreview } from './preview.ts'

export interface SleepablePreviewOpts {
	/** The already-running server (from the initial start). */
	initial: RunningPreview
	/** Wake: (re)start the dev server — skips install, deps are warm. */
	start: () => Promise<RunningPreview>
	/** Sleep after this long with no traffic. `<= 0` never sleeps. */
	idleMs: number
	logger: Logger
}

/** A preview whose dev-server process sleeps on idle and wakes on demand. */
export class SleepablePreview {
	private running: RunningPreview | null
	private idleTimer: NodeJS.Timeout | null = null
	private waking: Promise<void> | null = null
	private sleeping: Promise<void> | null = null
	private disposed = false

	constructor(private readonly opts: SleepablePreviewOpts) {
		this.running = opts.initial
		this.armIdle()
	}

	/** Mark activity — resets the idle timer while awake. */
	touch(): void {
		if (this.running) this.armIdle()
	}

	/** Resolve once the dev server is running, waking it if it had slept. */
	async ensureAwake(): Promise<void> {
		if (this.disposed) throw new Error('preview disposed')
		// Let an in-flight sleep finish releasing the port before we rebind it.
		if (this.sleeping) await this.sleeping
		if (this.running) {
			this.touch()
			return
		}
		if (this.waking) return this.waking
		this.waking = (async () => {
			this.opts.logger.info('preview: waking on request')
			const started = await this.opts.start()
			// Disposed while we were waking — don't leak the freshly-started server.
			if (this.disposed) {
				await started.stop().catch(() => undefined)
				return
			}
			this.running = started
			this.armIdle()
		})().finally(() => {
			this.waking = null
		})
		return this.waking
	}

	async dispose(): Promise<void> {
		this.disposed = true
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = null
		const r = this.running
		this.running = null
		if (r) await r.stop().catch(() => undefined)
	}

	private armIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = null
		if (this.opts.idleMs <= 0) return
		this.idleTimer = setTimeout(() => void this.sleep(), this.opts.idleMs)
		this.idleTimer.unref()
	}

	private async sleep(): Promise<void> {
		if (this.disposed || !this.running) return
		const r = this.running
		this.running = null
		this.opts.logger.info('preview: sleeping (idle)')
		this.sleeping = r.stop().catch(() => undefined)
		await this.sleeping
		this.sleeping = null
	}
}

export interface PreviewWakeHandle {
	ensureAwake(): Promise<void>
	touch(): void
}

/** Maps a preview's exposed ports to its wakeable handle. */
export class PreviewWaker {
	private readonly byPort = new Map<number, PreviewWakeHandle>()

	register(port: number, handle: PreviewWakeHandle): void {
		this.byPort.set(port, handle)
	}

	unregister(port: number): void {
		this.byPort.delete(port)
	}

	/** Wake the dev server behind `port` (no-op if the port isn't a preview). */
	async ensureAwake(port: number): Promise<void> {
		await this.byPort.get(port)?.ensureAwake()
	}

	touch(port: number): void {
		this.byPort.get(port)?.touch()
	}
}
