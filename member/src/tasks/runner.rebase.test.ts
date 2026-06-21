/**
 * End-to-end test of the `rebase` TaskKind through `TaskRunner.run()`, against
 * a real *local* bare repo (no network) via `NIGHT_GIT_REMOTE_BASE`. A fake
 * provider stands in for the LLM and resolves (or fails to resolve) the
 * conflict through the real `bash` tool, so this exercises the rescue
 * orchestration: verify-before-trust, the optional verify command gate, and
 * the force-with-lease push.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider, RunAgentOptions, RunAgentResult, TokenUsage } from '../agent/types.ts'
import { gh, git } from './git.ts'
import { TaskRunner, type AssignedTaskInput, type TaskRunnerDeps } from './runner.ts'

// Keep `git` real (the local-repo setup needs it); stub only `gh` so the PR
// comment posted on a rescue is observable instead of hitting GitHub.
vi.mock('./git.ts', async (orig) => {
	const actual = await orig<typeof import('./git.ts')>()
	return { ...actual, gh: vi.fn(async () => '') }
})

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	child: () => silentLogger,
} as unknown as Logger

const IDENT = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@e',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@e',
}
const gitc = (cwd: string, args: string[], env: Record<string, string> = {}) =>
	git(args, { cwd, env: { ...IDENT, ...env } })

const REPO = 'owner/name'

/** Build `<base>/owner/name.git` with a conflicting `feature` vs `main`. */
async function seedConflict(base: string): Promise<string> {
	const origin = join(base, REPO + '.git')
	await mkdir(join(base, 'owner'), { recursive: true })
	await gitc(base, ['init', '--bare', '-b', 'main', origin])
	const seed = join(base, 'seed')
	await gitc(base, ['clone', origin, seed])
	await writeFile(join(seed, 'f.txt'), 'a\nbase\nc\n')
	await gitc(seed, ['add', '-A'])
	await gitc(seed, ['commit', '-m', 'base'])
	await gitc(seed, ['push', 'origin', 'main'])
	await gitc(seed, ['checkout', '-b', 'feature'])
	await writeFile(join(seed, 'f.txt'), 'a\nFEATURE\nc\n')
	await gitc(seed, ['commit', '-am', 'feat'])
	await gitc(seed, ['push', 'origin', 'feature'])
	await gitc(seed, ['checkout', 'main'])
	await writeFile(join(seed, 'f.txt'), 'a\nMAIN\nc\n')
	await gitc(seed, ['commit', '-am', 'mainchange'])
	await gitc(seed, ['push', 'origin', 'main'])
	return origin
}

/** A provider that runs a fixed shell command via the real `bash` tool. */
class ScriptedProvider implements Provider {
	readonly name = 'anthropic' as const
	readonly model = 'fake'
	constructor(private readonly command: string | null) {}
	async runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
		if (this.command) {
			const bash = opts.tools.find((t) => t.name === 'bash')
			if (!bash) throw new Error('no bash tool')
			const res = await bash.run({ command: this.command })
			if (res.isError) throw new Error(`tool failed: ${res.output}`)
		}
		return { summary: 'done', usage: { input: 1, output: 1 } }
	}
}

const RESOLVE_CMD =
	"printf 'a\\nMERGED\\nc\\n' > f.txt && git add f.txt && " +
	'GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase --continue'

const NO_LIMITS = {
	maxTokensPerTask: null,
	maxTokensPerDay: null,
	maxTaskDurationMinutes: 120,
}

function rebaseTask(): AssignedTaskInput {
	return {
		taskId: 't-reb',
		kind: 'rebase',
		title: 'rebase PR',
		description: '',
		repo: REPO,
		prUrl: null,
		githubToken: 'unused-for-local',
		repoUrl: '',
		metadata: { head_ref: 'feature', base_ref: 'main' },
	}
}

describe('TaskRunner rebase rescue (local bare repo)', () => {
	let root: string
	let origin: string
	let priorBase: string | undefined

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'night-runner-rebase-'))
		priorBase = process.env.NIGHT_GIT_REMOTE_BASE
		process.env.NIGHT_GIT_REMOTE_BASE = root
		origin = await seedConflict(root)
	})
	afterEach(async () => {
		if (priorBase === undefined) delete process.env.NIGHT_GIT_REMOTE_BASE
		else process.env.NIGHT_GIT_REMOTE_BASE = priorBase
		await rm(root, { recursive: true, force: true })
	})

	function buildRunner(provider: Provider, extra: Partial<TaskRunnerDeps> = {}) {
		const sent: Array<{ kind?: string; payload?: unknown }> = []
		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider,
			limits: NO_LIMITS,
			dailyUsage: { tokensToday: () => 0, record: () => {} },
			workspaceDir: join(root, 'ws'),
			logger: silentLogger,
			wsSend: (msg) => {
				sent.push(msg as { kind?: string; payload?: unknown })
				return true
			},
			stubMode: false,
			preview: {
				ports: [{ port: 4321, label: 'app' }],
				readyTimeoutMs: 120_000,
				publishMode: 'local',
				domain: null,
				sleepAfterMs: 0,
			},
			...extra,
		})
		return { runner, sent }
	}

	const featureSha = () => gitc(origin, ['rev-parse', 'feature']).then((s) => s.trim())
	const featureBehindMain = () =>
		gitc(origin, ['rev-list', '--count', 'feature..main']).then((s) => Number(s.trim()))

	it('resolves the conflict via the agent and force-pushes the rebased branch', async () => {
		const before = await featureSha()
		const { runner, sent } = buildRunner(new ScriptedProvider(RESOLVE_CMD))

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('completed')
		expect(outcome.result).toMatchObject({ rebased: true })
		// Origin advanced and now contains base (rebase landed).
		expect(await featureSha()).not.toBe(before)
		expect(await featureBehindMain()).toBe(0)
		// The rescue path was actually taken.
		const outcomes = sent
			.filter((m) => m.kind === 'rebase')
			.map((m) => (m.payload as { outcome?: string }).outcome)
		expect(outcomes).toContain('rescued')
	})

	it('does not push and fails when the agent cannot resolve the conflict', async () => {
		const before = await featureSha()
		const { runner } = buildRunner(new ScriptedProvider(null)) // no-op agent

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('failed')
		expect(outcome.reason).toBe('rebase_conflict')
		expect(await featureSha()).toBe(before) // untouched
	})

	it('blocks the push when the verify command fails after a rescue', async () => {
		const before = await featureSha()
		const { runner } = buildRunner(new ScriptedProvider(RESOLVE_CMD), {
			rebaseVerifyCommand: 'exit 1',
		})

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('failed')
		expect(outcome.reason).toBe('rebase_verify_failed')
		expect(await featureSha()).toBe(before) // resolved locally, never pushed
	})

	it('comments on the PR when a rescue lands', async () => {
		vi.mocked(gh).mockClear()
		const task: AssignedTaskInput = {
			...rebaseTask(),
			prUrl: 'https://github.com/owner/name/pull/7',
		}
		const { runner } = buildRunner(new ScriptedProvider(RESOLVE_CMD))

		const outcome = await runner.run(task)

		expect(outcome.type).toBe('completed')
		const comment = vi
			.mocked(gh)
			.mock.calls.find((c) => c[0][0] === 'pr' && c[0][1] === 'comment')
		expect(comment).toBeTruthy()
		expect(String(comment![0][4])).toContain('resolved automatically')
		// Attribution marker keeps Household from treating it as a human reply.
		expect(String(comment![0][4])).toContain('night-family:member=')
	})

	it('passes the verify command and pushes when it succeeds', async () => {
		const before = await featureSha()
		const { runner } = buildRunner(new ScriptedProvider(RESOLVE_CMD), {
			rebaseVerifyCommand: 'test -f f.txt',
		})

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('completed')
		expect(await featureSha()).not.toBe(before)
	})
})
