/**
 * Documentation pages served from the dashboard. We keep them on the web
 * (rather than only README.md) so operators can read them next to the
 * dashboard they're configuring, no shell access required.
 *
 * Pages are defined statically in `DOC_PAGES` below; add an entry +
 * component to publish a new one. The router has two routes (see
 * `router.tsx`): `/docs` for the index, `/docs/$slug` for a page.
 */

import { Alert, Box, Paper, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { EmptyState, Section } from './Root.tsx'

interface DocPage {
	slug: string
	title: string
	summary: string
	render: () => ReactNode
}

const DOC_PAGES: DocPage[] = [
	{
		slug: 'repo-setup',
		title: 'Set up a GitHub repo for Night Family',
		summary:
			'Wire up the `night` label, the webhook, the bot account and the Member PAT scopes so issues actually flow.',
		render: RepoSetup,
	},
	{
		slug: 'issue-to-pr',
		title: 'How an issue becomes a PR',
		summary:
			'Two-stage flow: triage during the day asks/clarifies and writes a plan; implementation runs at night.',
		render: IssueToPr,
	},
	{
		slug: 'schedule',
		title: 'Member schedule (when does it implement?)',
		summary:
			'Customize the per-Member `schedule.yaml` to control when `implement` is offered. Day vs. night, lunch breaks, vacation dates.',
		render: Schedule,
	},
]

export function DocsIndex() {
	return (
		<Section title="Docs">
			<Stack spacing={2}>
				<Typography variant="body2" color="text.secondary">
					Operator-facing how-tos. The README has the developer setup; these pages cover
					the things you do once Night Family is running.
				</Typography>
				<Stack spacing={1}>
					{DOC_PAGES.map((p) => (
						<Paper key={p.slug} variant="outlined" sx={{ p: 2 }}>
							<Stack spacing={0.5}>
								<Link
									to="/docs/$slug"
									params={{ slug: p.slug }}
									style={{
										fontWeight: 600,
										color: 'inherit',
										textDecoration: 'none',
									}}
								>
									{p.title}
								</Link>
								<Typography variant="body2" color="text.secondary">
									{p.summary}
								</Typography>
							</Stack>
						</Paper>
					))}
				</Stack>
			</Stack>
		</Section>
	)
}

export function DocPageView({ slug }: { slug: string }) {
	const page = DOC_PAGES.find((p) => p.slug === slug)
	return (
		<>
			<Box sx={{ mb: 2 }}>
				<Link
					to="/docs"
					style={{
						color: 'inherit',
						textDecoration: 'none',
						display: 'inline-flex',
						alignItems: 'center',
						gap: 6,
						fontSize: '0.875rem',
					}}
				>
					<ArrowBackIcon fontSize="small" />
					Back to docs
				</Link>
			</Box>
			{!page ? (
				<EmptyState>No such page.</EmptyState>
			) : (
				<>
					<Typography variant="h5" sx={{ fontWeight: 600, mb: 2 }}>
						{page.title}
					</Typography>
					<Article>{page.render()}</Article>
				</>
			)}
		</>
	)
}

function Article({ children }: { children: ReactNode }) {
	return (
		<Box
			sx={{
				maxWidth: 760,
				'& h2': { mt: 3, mb: 1, fontSize: '1.25rem', fontWeight: 600 },
				'& h3': { mt: 2.5, mb: 1, fontSize: '1.05rem', fontWeight: 600 },
				'& p': { my: 1, lineHeight: 1.65 },
				'& ul': { my: 1, pl: 3 },
				'& li': { my: 0.5 },
				'& code': {
					fontFamily: 'monospace',
					bgcolor: 'action.hover',
					px: 0.5,
					borderRadius: 0.5,
					fontSize: '0.92em',
				},
				'& pre': {
					fontFamily: 'monospace',
					bgcolor: 'action.hover',
					p: 1.5,
					borderRadius: 1,
					overflowX: 'auto',
					fontSize: '0.85em',
				},
				'& pre code': { bgcolor: 'transparent', p: 0 },
			}}
		>
			{children}
		</Box>
	)
}

// ── Page bodies ───────────────────────────────────────────────────────

function RepoSetup() {
	return (
		<>
			<p>
				Night Family watches GitHub through a webhook per repository. To make a repo work
				with your fleet, three things need to be set up: the <code>night</code> label, the
				webhook binding, and the Member's PAT.
			</p>

			<h2>
				1. Add the <code>night</code> label
			</h2>
			<p>
				The Member only acts on issues tagged with the literal label name <code>night</code>
				. Add it once to the repo (Issues → Labels → New label) — any name is fine, but the
				code looks for <code>night</code> exactly.
			</p>
			<p>
				If you want the label to be auto-applied to incoming issues (so contributors don't
				have to remember), use{' '}
				<a
					href="https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/configuring-issue-templates-for-your-repository"
					target="_blank"
					rel="noreferrer"
				>
					an issue template
				</a>{' '}
				with <code>labels: [night]</code> in the front-matter. Or use a small action that
				labels every new issue automatically.
			</p>

			<h2>2. Bind the webhook</h2>
			<p>
				Go to <strong>Settings → Repositories</strong> in this dashboard and use the wizard.
				It generates a payload URL + secret and walks you through pasting them on GitHub.
				Subscribe to events: <em>Issues</em>, <em>Issue comments</em>,{' '}
				<em>Pull requests</em>, <em>Pull request reviews</em>.
			</p>

			<h2>3. Pick the Member's GitHub identity</h2>
			<p>
				Strongly recommended: <strong>create a separate GitHub account</strong> for the
				Member's PAT. Reasons:
			</p>
			<ul>
				<li>
					GitHub forbids approving your own PR. With your personal PAT the Member can't
					give an <em>approve</em> verdict on its own work; with a bot account it can.
				</li>
				<li>
					Triage cycles trigger on every <em>human</em> comment. With a shared account,
					Night Family relies on a hidden marker (
					<code>{'<!-- night-family:... -->'}</code>) embedded in bot comments to tell
					them apart from your hand-typed ones — robust, but the separate-account
					convention makes it trivial.
				</li>
				<li>Audit trail in the GitHub UI is unambiguous about who wrote what.</li>
			</ul>
			<p>Recommended PAT scopes:</p>
			<ul>
				<li>
					<strong>Fine-grained PAT (preferred):</strong> on the bound repos —{' '}
					<code>contents=read+write</code>, <code>pull_requests=read+write</code>,{' '}
					<code>issues=read+write</code>, <code>metadata=read</code>.
				</li>
				<li>
					<strong>Classic PAT:</strong> <code>repo</code> scope is enough. Add{' '}
					<code>workflow</code> only if the agent must touch GitHub Actions files.
				</li>
			</ul>
			<p>
				Paste the token into <code>GITHUB_PAT</code> in the Member's{' '}
				<code>.env.member</code>. The Member's identity (login + display name) is derived
				from <code>GET /user</code> at startup, so the PAT decides who the bot acts as.
			</p>

			<h2>4. Try it</h2>
			<p>
				Open an issue, label it <code>night</code>. Within a few seconds the Member should
				post a triage comment — a question, or a plan. Keep replying; once the plan is
				written, an implement task is queued for tonight.
			</p>
		</>
	)
}

function IssueToPr() {
	return (
		<>
			<p>
				Each labelled issue (label name: <code>night</code>) goes through two stages.
			</p>

			<h2>Stage 1: Triage (any time of day)</h2>
			<p>The Member reads the issue thread and either</p>
			<ul>
				<li>posts a clarifying question if the spec is too vague, or</li>
				<li>
					posts a plan comment summarising <em>what</em> + <em>how</em>, plus a size
					estimate (S / M / L / XL).
				</li>
			</ul>
			<p>
				Triage tasks are queued for every <code>issues.opened</code> (with the{' '}
				<code>night</code> label) and every <em>human</em>{' '}
				<code>issue_comment.created</code> on a labelled issue. As long as the human keeps
				replying, the cycle keeps refining. When the human stops, the cycle stops — there's
				no polling.
			</p>

			<h2>Stage 2: Implement (overnight, when the schedule allows)</h2>
			<p>
				A <em>plan</em> outcome from triage automatically queues an <code>implement</code>{' '}
				task for the same issue. It sits in the queue until a Member with the{' '}
				<code>implement</code> skill is available — by default that's during the night
				window. The implement Member opens a draft PR, runs tests, and marks it ready.
			</p>

			<h2>Bot vs. human comments</h2>
			<p>
				Every comment, review, and PR body posted by a Member ends with a deterministic
				marker (<code>{'<!-- night-family:member=… task=… -->'}</code>). The webhook handler
				greps for it and skips re-triggering triage on Member-authored comments. So long as
				your hand-written comments don't carry that marker, they always trigger a fresh
				triage cycle.
			</p>

			<h2>Brakes (so a chatty issue can't spam the queue)</h2>
			<ul>
				<li>
					<strong>Idempotence:</strong> at most one active triage task per issue at a
					time.
				</li>
				<li>
					<strong>Per-issue daily cap:</strong> at most 5 triage tasks for a single issue
					in any rolling 24 h.
				</li>
				<li>
					<strong>Per-issue lifetime cap:</strong> at most 20 triage tasks per issue,
					ever. Hard ceiling against runaway loops.
				</li>
				<li>
					<strong>
						<code>MAX_TOKENS_PER_DAY</code>
					</strong>
					: pre-existing per-Member quota; an indirect brake on cost.
				</li>
			</ul>

			<Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
				The estimation step (<code>estimate</code> skill / kind) is{' '}
				<strong>deprecated as of protocol 2.2.0</strong>. Triage does the analytical work
				that estimation used to do, plus the questions / plan, in one pass.
			</Alert>
		</>
	)
}

function Schedule() {
	return (
		<>
			<p>
				The configured skill set comes from <code>SKILLS</code> env in the Member's{' '}
				<code>.env.member</code> (default = all of <code>implement</code> /{' '}
				<code>review</code> / <code>triage</code> / <code>respond</code> /{' '}
				<code>summarize</code>). The schedule then gates <code>implement</code> in time:
				when any <code>nightWindow</code> is active, all configured skills are offered;
				outside every window, <code>implement</code> is dropped and the rest pass through.
			</p>

			<h2>
				Default behavior (no <code>schedule.yaml</code>)
			</h2>
			<ul>
				<li>Night window: 22:00–08:00 local, every day.</li>
				<li>Lunch window: 12:00–13:00, weekdays only.</li>
				<li>
					Outside both: review-only (drops <code>implement</code>).
				</li>
			</ul>

			<h2>Customizing</h2>
			<p>
				Generate a starter file: <code>npm run -w @night/member init-schedule</code>. That
				writes <code>schedule.yaml</code> to the repo root. Each <code>nightWindow</code>{' '}
				has either <code>days</code> (weekdays) or <code>dates</code> (specific calendar
				dates — useful for vacations). <code>start</code> and <code>end</code> are optional{' '}
				<code>HH:MM</code> strings — omit both for an all-day window.{' '}
				<code>start &gt; end</code> wraps past midnight.
			</p>

			<h2>Lookup chain (first hit wins)</h2>
			<ol>
				<li>
					<code>SCHEDULE_FILE</code> env var
				</li>
				<li>
					<code>/etc/night-family/schedule.yaml</code> (Docker convention)
				</li>
				<li>
					<code>&lt;repo-root&gt;/schedule.yaml</code> (dev convention)
				</li>
				<li>Built-in default</li>
			</ol>
			<p>
				For Docker, uncomment the <code>schedule.yaml</code> bind mount in{' '}
				<code>docker-compose.member.yml</code>. For <code>npm run dev</code>, just drop the
				file in the repo root — it's gitignored.
			</p>

			<h2>One-off override (UI)</h2>
			<p>
				On the Member detail page, admins can push a temporary override ("Implement-only for
				the next 2 h") that expires automatically. Useful when you're stepping away from the
				keyboard and want implementation work to start immediately.
			</p>
		</>
	)
}
