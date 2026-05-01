import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBuffer, eventFilePath } from './eventBuffer.ts'

describe('EventBuffer', () => {
	let dir: string
	let path: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'evbuf-'))
		path = eventFilePath(dir, 'task-1')
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('appends with monotonic seq starting at 1', async () => {
		const buf = new EventBuffer('task-1', path)
		const a = await buf.append('log', { msg: 'a' })
		const b = await buf.append('log', { msg: 'b' })
		const c = await buf.append('commit', { sha: 'abc' })
		expect(a.seq).toBe(1)
		expect(b.seq).toBe(2)
		expect(c.seq).toBe(3)
		expect(buf.lastSeq).toBe(3)
	})

	it('persists events to disk in NDJSON form', async () => {
		const buf = new EventBuffer('task-1', path)
		await buf.append('log', { msg: 'hello' })
		await buf.append('commit', { sha: 'deadbeef' })
		const raw = await readFile(path, 'utf8')
		const lines = raw.trim().split('\n')
		expect(lines).toHaveLength(2)
		const first = JSON.parse(lines[0]!) as {
			seq: number
			kind: string
			payload: { msg: string }
		}
		expect(first.seq).toBe(1)
		expect(first.kind).toBe('log')
		expect(first.payload.msg).toBe('hello')
	})

	it('restores nextSeq after restart (load reads max seq from disk)', async () => {
		const first = new EventBuffer('task-1', path)
		await first.append('log', { i: 1 })
		await first.append('log', { i: 2 })
		await first.append('log', { i: 3 })

		const second = new EventBuffer('task-1', path)
		await second.load()
		expect(second.lastSeq).toBe(3)

		const next = await second.append('log', { i: 4 })
		expect(next.seq).toBe(4)
	})

	it('iterFrom yields only events with seq >= fromSeq', async () => {
		const buf = new EventBuffer('task-1', path)
		await buf.append('log', { i: 1 })
		await buf.append('log', { i: 2 })
		await buf.append('log', { i: 3 })
		await buf.append('log', { i: 4 })

		const seqs: number[] = []
		for await (const ev of buf.iterFrom(3)) seqs.push(ev.seq)
		expect(seqs).toEqual([3, 4])
	})

	it('iterFrom emits MsgEvent shape (type=event, task_id, ts, kind, payload)', async () => {
		const buf = new EventBuffer('task-1', path)
		await buf.append('commit', { sha: 'abc123' })

		const out: unknown[] = []
		for await (const ev of buf.iterFrom(1)) out.push(ev)
		expect(out).toHaveLength(1)
		const ev = out[0] as {
			type: string
			task_id: string
			seq: number
			ts: string
			kind: string
			payload: { sha: string }
		}
		expect(ev.type).toBe('event')
		expect(ev.task_id).toBe('task-1')
		expect(ev.seq).toBe(1)
		expect(ev.kind).toBe('commit')
		expect(ev.payload.sha).toBe('abc123')
		expect(typeof ev.ts).toBe('string')
		expect(Number.isFinite(Date.parse(ev.ts))).toBe(true)
	})

	it('iterFrom yields nothing before any append', async () => {
		const buf = new EventBuffer('task-1', path)
		const out: unknown[] = []
		for await (const ev of buf.iterFrom(1)) out.push(ev)
		expect(out).toEqual([])
	})

	it('skips malformed lines on load and iterFrom', async () => {
		// Simulate a partially-corrupted ndjson — Member crashed mid-write or
		// disk got truncated. Buffer should recover gracefully and still
		// produce valid replay.
		const valid1 = JSON.stringify({
			taskId: 'task-1',
			seq: 1,
			ts: new Date().toISOString(),
			kind: 'log',
			payload: { i: 1 },
		})
		const valid2 = JSON.stringify({
			taskId: 'task-1',
			seq: 2,
			ts: new Date().toISOString(),
			kind: 'log',
			payload: { i: 2 },
		})
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, [valid1, '{not json', '', valid2].join('\n') + '\n', 'utf8')

		const buf = new EventBuffer('task-1', path)
		await buf.load()
		expect(buf.lastSeq).toBe(2)

		const seqs: number[] = []
		for await (const ev of buf.iterFrom(1)) seqs.push(ev.seq)
		expect(seqs).toEqual([1, 2])
	})

	it('watermark starts at 0 and tracks markSent monotonically', async () => {
		const buf = new EventBuffer('task-1', path)
		expect(buf.watermark).toBe(0)
		buf.markSent(2)
		expect(buf.watermark).toBe(2)
		// Going backwards is a no-op (replay can re-send earlier seqs without
		// regressing the high-water mark).
		buf.markSent(1)
		expect(buf.watermark).toBe(2)
		buf.markSent(5)
		expect(buf.watermark).toBe(5)
	})

	it('load() after a graceful shutdown sets watermark to lastSeq', async () => {
		// On reconnect, Household will tell us the true watermark via
		// replay_request; until then assume everything was sent.
		const first = new EventBuffer('task-1', path)
		await first.append('log', { i: 1 })
		await first.append('log', { i: 2 })

		const second = new EventBuffer('task-1', path)
		await second.load()
		expect(second.watermark).toBe(2)
	})

	it('append creates parent directories if missing', async () => {
		const nestedPath = eventFilePath(join(dir, 'deeply', 'nested'), 'task-2')
		const buf = new EventBuffer('task-2', nestedPath)
		await buf.append('log', { ok: true })
		const raw = await readFile(nestedPath, 'utf8')
		expect(raw).toContain('"seq":1')
	})

	it('deleteFile removes the ndjson', async () => {
		const buf = new EventBuffer('task-1', path)
		await buf.append('log', { i: 1 })
		expect(buf.fileExists).toBe(true)
		await buf.deleteFile()
		expect(buf.fileExists).toBe(false)
	})

	it('deleteFile is idempotent when file is absent', async () => {
		const buf = new EventBuffer('task-1', path)
		await expect(buf.deleteFile()).resolves.toBeUndefined()
	})
})

describe('eventFilePath', () => {
	it('joins workspace + taskId + events.ndjson', () => {
		expect(eventFilePath('/work', 'task-7')).toBe('/work/task-7/events.ndjson')
	})
})
