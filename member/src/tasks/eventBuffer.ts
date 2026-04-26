/**
 * Per-task append-only event log on disk (`<workspace>/<task-id>/events.ndjson`).
 *
 * Why on disk: Member must survive Household outages (and its own restart).
 * Agent loop keeps appending; events sync to Household when the WS is up.
 *
 * Sequence numbers are monotonic per task, starting at 1. The buffer is
 * naturally bounded — without Household, no new tasks arrive, so only the
 * current task's ndjson grows. No rotation policy needed.
 */

import { createReadStream, existsSync } from 'node:fs'
import { mkdir, appendFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { EventKind, MsgEvent } from '@night/shared'

export interface BufferedEvent {
	taskId: string
	seq: number
	ts: string
	kind: EventKind
	payload: unknown
}

export class EventBuffer {
	private nextSeq = 1
	private lastSentSeq = 0
	private loaded = false

	constructor(
		readonly taskId: string,
		readonly path: string,
	) {}

	get fileExists(): boolean {
		return existsSync(this.path)
	}

	/**
	 * Restore in-memory cursor from disk. Safe to call multiple times.
	 */
	async load(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		if (!existsSync(this.path)) return

		let maxSeq = 0
		await iterEvents(this.path, (evt) => {
			if (evt.seq > maxSeq) maxSeq = evt.seq
		})
		this.nextSeq = maxSeq + 1
		// Optimistically assume everything was persisted before disconnect; on
		// reconnect Household will tell us the real watermark via replay_request.
		this.lastSentSeq = maxSeq
	}

	async append(kind: EventKind, payload: unknown): Promise<BufferedEvent> {
		if (!this.loaded) await this.load()
		await mkdir(dirname(this.path), { recursive: true })
		const ev: BufferedEvent = {
			taskId: this.taskId,
			seq: this.nextSeq++,
			ts: new Date().toISOString(),
			kind,
			payload,
		}
		await appendFile(this.path, JSON.stringify(ev) + '\n', 'utf8')
		return ev
	}

	get lastSeq(): number {
		return this.nextSeq - 1
	}

	markSent(seq: number): void {
		if (seq > this.lastSentSeq) this.lastSentSeq = seq
	}

	get watermark(): number {
		return this.lastSentSeq
	}

	/**
	 * Stream events with seq ≥ fromSeq. Used for replay after reconnect.
	 */
	async *iterFrom(fromSeq: number): AsyncIterable<MsgEvent> {
		if (!existsSync(this.path)) return
		const stream = createReadStream(this.path, { encoding: 'utf8' })
		const rl = createInterface({ input: stream, crlfDelay: Infinity })
		for await (const line of rl) {
			if (!line) continue
			let ev: BufferedEvent
			try {
				ev = JSON.parse(line) as BufferedEvent
			} catch {
				continue
			}
			if (ev.seq < fromSeq) continue
			yield {
				type: 'event',
				task_id: ev.taskId,
				seq: ev.seq,
				ts: ev.ts,
				kind: ev.kind,
				payload: ev.payload,
			}
		}
	}

	/**
	 * Delete the entire ndjson file. Caller must ensure all events have been
	 * acked by Household (and the 24h grace period elapsed) before doing so.
	 */
	async deleteFile(): Promise<void> {
		await rm(this.path, { force: true })
	}
}

async function iterEvents(path: string, fn: (e: BufferedEvent) => void): Promise<void> {
	const stream = createReadStream(path, { encoding: 'utf8' })
	const rl = createInterface({ input: stream, crlfDelay: Infinity })
	for await (const line of rl) {
		if (!line) continue
		try {
			fn(JSON.parse(line) as BufferedEvent)
		} catch {
			// skip malformed lines
		}
	}
}

export function eventFilePath(workspaceDir: string, taskId: string): string {
	return join(workspaceDir, taskId, 'events.ndjson')
}
