/**
 * Household env-driven config. Loaded once at process start.
 */

export interface HouseholdConfig {
	householdName: string
	primaryAdminGithubUsername: string | null
	requireUiLogin: boolean
	port: number
	dataDir: string
	configDir: string
	githubOauth: {
		clientId: string
		clientSecret: string
	} | null
	secretsKey: string | null
	logLevel: string
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) {
		throw new Error(`Missing required env var: ${name}`)
	}
	return v
}

function optional(name: string, fallback: string): string {
	return process.env[name] ?? fallback
}

function optionalNullable(name: string): string | null {
	const value = process.env[name]
	return value && value.length > 0 ? value : null
}

function parseBoolean(name: string): boolean {
	const raw = required(name).trim().toLowerCase()
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`Invalid boolean env var ${name}: expected true or false`)
}

export function loadConfig(): HouseholdConfig {
	const requireUiLogin = parseBoolean('REQUIRE_UI_LOGIN')
	const clientId = optionalNullable('GITHUB_OAUTH_CLIENT_ID')
	const clientSecret = optionalNullable('GITHUB_OAUTH_CLIENT_SECRET')
	const primaryAdminGithubUsername = optionalNullable('PRIMARY_ADMIN_GITHUB_USERNAME')

	if (requireUiLogin) {
		if (!primaryAdminGithubUsername) {
			throw new Error('Missing required env var: PRIMARY_ADMIN_GITHUB_USERNAME')
		}
		if (!clientId) {
			throw new Error('Missing required env var: GITHUB_OAUTH_CLIENT_ID')
		}
		if (!clientSecret) {
			throw new Error('Missing required env var: GITHUB_OAUTH_CLIENT_SECRET')
		}
	}

	const githubOauth = clientId && clientSecret ? { clientId, clientSecret } : null

	return {
		householdName: optional('HOUSEHOLD_NAME', 'Somnambulator'),
		primaryAdminGithubUsername,
		requireUiLogin,
		port: Number.parseInt(optional('PORT', '8080'), 10),
		dataDir: optional('DATA_DIR', '/data'),
		configDir: optional('CONFIG_DIR', '/config'),
		githubOauth,
		secretsKey: process.env['SECRETS_KEY'] ?? null,
		logLevel: optional('LOG_LEVEL', 'info'),
	}
}
