import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { defaultScheduleYaml, findRepoRoot } from './schedule.ts'

/**
 * Write a fully commented starter `schedule.yaml`.
 *
 *   npm run -w @night/member init-schedule              # → <repo-root>/schedule.yaml
 *   npm run -w @night/member init-schedule -- ./foo.yaml # → ./foo.yaml
 *
 * Writing directly (rather than `>` redirect) sidesteps npm's script
 * header (`> @night/member@0.0.0 init-schedule …`) ending up at the top
 * of the file. By default, lands in the repo root so `npm run dev`
 * picks it up via the schedule lookup chain. Refuses to overwrite an
 * existing file unless `--force` is passed — schedules tend to get
 * customized and clobbering them silently is rude.
 */

const args = process.argv.slice(2)
const force = args.includes('--force')
const positional = args.filter((a) => a !== '--force')

const target = resolveTarget(positional[0])
if (!force && existsSync(target)) {
	process.stderr.write(
		`${target} already exists.\n` +
			`Pass --force to overwrite, or remove it first.\n` +
			`Edit the file instead of regenerating if you've customized it.\n`,
	)
	process.exit(2)
}

writeFileSync(target, defaultScheduleYaml())
process.stderr.write(`Wrote ${target}\n`)

function resolveTarget(arg: string | undefined): string {
	if (arg) return isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
	const root = findRepoRoot()
	if (!root) {
		process.stderr.write(
			`Could not locate the night-family repo root from ${process.cwd()}.\n` +
				`Pass an explicit path: ... init-schedule -- /path/to/schedule.yaml\n`,
		)
		process.exit(2)
	}
	return resolve(root, 'schedule.yaml')
}
