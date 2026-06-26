import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { defaultMcpConfigYaml } from './agent/mcp-config.ts'
import { findRepoRoot } from './schedule.ts'

/**
 * Write a generic, fully-commented starter `mcp.yaml`.
 *
 *   npm run member:generate-mcp-config              # → <repo-root>/mcp.yaml
 *   npm run member:generate-mcp-config -- ./foo.yaml # → ./foo.yaml
 *
 * Night Family has no built-in knowledge of any specific service — every MCP
 * server publishes its own config snippet in its docs. This just lays down the
 * generic skeleton (the two transport shapes, the `${VAR}` secret convention,
 * the `allow` allowlist, the security notes) for you to paste those snippets
 * into. Mirrors `init-schedule`: writes directly (so npm's script header
 * doesn't end up in the file) and refuses to overwrite without `--force`.
 */

const args = process.argv.slice(2)
const force = args.includes('--force')
const positional = args.filter((a) => !a.startsWith('--'))
const target = resolveTarget(positional[0])

if (!force && existsSync(target)) {
	process.stderr.write(
		`${target} already exists.\n` + `Pass --force to overwrite, or edit the file by hand.\n`,
	)
	process.exit(2)
}

writeFileSync(target, defaultMcpConfigYaml())
process.stderr.write(
	`Wrote ${target}\n` +
		`Edit it: paste each MCP server's snippet (from its own docs) under ` +
		`mcpServers, put secrets in .env.member, then restart the member.\n`,
)

function resolveTarget(arg: string | undefined): string {
	if (arg) return isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
	const root = findRepoRoot()
	if (!root) {
		process.stderr.write(
			`Could not locate the night-family repo root from ${process.cwd()}.\n` +
				`Pass an explicit path: ... generate-mcp-config -- /path/to/mcp.yaml\n`,
		)
		process.exit(2)
	}
	return resolve(root, 'mcp.yaml')
}
