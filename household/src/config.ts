/**
 * Household env-driven config. Loaded once at process start.
 */

export interface HouseholdConfig {
	householdName: string
	primaryAdminGithubUsername: string
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

export function loadConfig(): HouseholdConfig {
	const clientId = process.env['GITHUB_OAUTH_CLIENT_ID']
	const clientSecret = process.env['GITHUB_OAUTH_CLIENT_SECRET']
	const githubOauth = clientId && clientSecret ? { clientId, clientSecret } : null

	return {
		householdName: optional('HOUSEHOLD_NAME', 'Somnambulator'),
		primaryAdminGithubUsername: required('PRIMARY_ADMIN_GITHUB_USERNAME'),
		port: Number.parseInt(optional('PORT', '8080'), 10),
		dataDir: optional('DATA_DIR', '/data'),
		configDir: optional('CONFIG_DIR', '/config'),
		githubOauth,
		secretsKey: process.env['SECRETS_KEY'] ?? null,
		logLevel: optional('LOG_LEVEL', 'info'),
	}
}
