/**
 * Runtime schemas for the Household ↔ Member wire protocol.
 *
 * `protocol.ts` defines the types (a contract for code paths that produce
 * messages); this file defines schemas (a contract for code paths that
 * consume them off the wire). Producers stay typed; consumers validate.
 *
 * Consumers should call `parseMemberToHousehold` / `parseHouseholdToMember`
 * instead of the bare `decode()` helper. Anything that fails schema
 * validation is dropped with a log entry — that is the implementation of the
 * "ignore unknown messages" half of the minor-bump compatibility rule.
 */

import * as v from 'valibot'
import type {
	Day,
	EventKind,
	HouseholdToMember,
	McpServerInfo,
	MemberStatus,
	MemberToHousehold,
	Provider,
	Skill,
	TaskKind,
	WorkerProfile,
} from './protocol.ts'

const SkillSchema = v.picklist([
	'implement',
	'review',
	'triage',
	'respond',
	'summarize',
	'preview',
] satisfies Skill[])

const ProviderSchema = v.picklist(['anthropic', 'gemini', 'openai'] satisfies Provider[])

const WorkerProfileSchema = v.picklist(['hard', 'medium', 'lazy'] satisfies WorkerProfile[])

const MemberStatusSchema = v.picklist(['idle', 'busy'] satisfies MemberStatus[])

const TaskKindSchema = v.picklist([
	'implement',
	'review',
	'triage',
	'respond',
	'summarize',
	'rebase',
	'preview',
] satisfies TaskKind[])

const DaySchema = v.picklist(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] satisfies Day[])

const HHMMSchema = v.pipe(v.string(), v.regex(/^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/))

const NightWindowSchema = v.object({
	name: v.string(),
	days: v.optional(v.array(DaySchema)),
	dates: v.optional(v.array(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)))),
	start: HHMMSchema,
	end: HHMMSchema,
})

const ScheduleSchema = v.object({
	timezone: v.string(),
	nightWindows: v.array(NightWindowSchema),
})

const ResumeRefSchema = v.object({
	task_id: v.string(),
	last_seq: v.number(),
})

const AssignedTaskSchema = v.object({
	task_id: v.string(),
	kind: TaskKindSchema,
	title: v.string(),
	description: v.string(),
	repo: v.optional(v.string()),
	pr_url: v.optional(v.string()),
	metadata: v.optional(v.record(v.string(), v.unknown())),
})

// ---------------- Member → Household ----------------

const McpServerInfoSchema = v.object({
	name: v.string(),
	status: v.picklist(['live', 'down'] satisfies McpServerInfo['status'][]),
	tool_count: v.number(),
})

const MsgHandshakeSchema = v.object({
	type: v.literal('handshake'),
	protocol_version: v.string(),
	member_id: v.string(),
	member_name: v.string(),
	display_name: v.string(),
	skills: v.array(SkillSchema),
	schedule: ScheduleSchema,
	provider: ProviderSchema,
	model: v.string(),
	worker_profile: WorkerProfileSchema,
	repos: v.optional(v.array(v.string())),
	resumes: v.optional(v.array(ResumeRefSchema)),
	max_tokens_per_day: v.optional(v.number()),
	mcp_servers: v.optional(v.array(McpServerInfoSchema)),
})

const MsgMemberReadySchema = v.object({ type: v.literal('member.ready') })

const MsgMemberBusySchema = v.object({
	type: v.literal('member.busy'),
	task_id: v.string(),
})

const MsgTaskAckSchema = v.object({
	type: v.literal('task.ack'),
	task_id: v.string(),
})

const MsgTaskCompletedSchema = v.object({
	type: v.literal('task.completed'),
	task_id: v.string(),
	result: v.unknown(),
	pr_url: v.optional(v.string()),
})

const MsgTaskFailedSchema = v.object({
	type: v.literal('task.failed'),
	task_id: v.string(),
	reason: v.string(),
})

const MsgEventSchema = v.object({
	type: v.literal('event'),
	task_id: v.string(),
	seq: v.number(),
	ts: v.string(),
	kind: v.picklist([
		'tool_call',
		'file_edited',
		'commit',
		'usage',
		'log',
		'rebase',
		'preview',
	] satisfies EventKind[]),
	payload: v.unknown(),
})

const MsgHeartbeatSchema = v.object({
	type: v.literal('heartbeat'),
	status: MemberStatusSchema,
	current_task: v.nullable(v.string()),
})

const MsgPongSchema = v.object({ type: v.literal('pong') })

const MsgMemberReposSchema = v.object({
	type: v.literal('member.repos'),
	repos: v.array(v.string()),
})

const MsgMemberReposErrorSchema = v.object({
	type: v.literal('member.repos_error'),
	reason: v.string(),
	error: v.string(),
})

const MsgMcpSchema = v.object({
	type: v.literal('member.mcp'),
	servers: v.array(McpServerInfoSchema),
})

const MemberToHouseholdSchema = v.variant('type', [
	MsgHandshakeSchema,
	MsgMemberReadySchema,
	MsgMemberBusySchema,
	MsgTaskAckSchema,
	MsgTaskCompletedSchema,
	MsgTaskFailedSchema,
	MsgEventSchema,
	MsgHeartbeatSchema,
	MsgPongSchema,
	MsgMemberReposSchema,
	MsgMemberReposErrorSchema,
	MsgMcpSchema,
])

// ---------------- Household → Member ----------------

const MsgHandshakeAckSchema = v.object({
	type: v.literal('handshake.ack'),
	household_name: v.string(),
	session_id: v.string(),
	protocol_version: v.string(),
})

const MsgHandshakeRejectSchema = v.object({
	type: v.literal('handshake.reject'),
	reason: v.string(),
})

const MsgTaskAssignedSchema = v.object({
	type: v.literal('task.assigned'),
	task: AssignedTaskSchema,
})

const MsgEventsReplayRequestSchema = v.object({
	type: v.literal('events.replay_request'),
	task_id: v.string(),
	from_seq: v.number(),
})

const MsgTaskCancelSchema = v.object({
	type: v.literal('task.cancel'),
	task_id: v.string(),
	reason: v.string(),
})

const MsgPingSchema = v.object({ type: v.literal('ping') })

const MsgReposRefreshSchema = v.object({
	type: v.literal('repos.refresh'),
	reason: v.string(),
})

const HouseholdToMemberSchema = v.variant('type', [
	MsgHandshakeAckSchema,
	MsgHandshakeRejectSchema,
	MsgTaskAssignedSchema,
	MsgEventsReplayRequestSchema,
	MsgTaskCancelSchema,
	MsgPingSchema,
	MsgReposRefreshSchema,
])

// ---------------- Public API ----------------

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string }

function parseWithSchema<T>(schema: v.GenericSchema<unknown, T>, raw: string): ParseResult<T> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		return { ok: false, error: `invalid_json: ${(err as Error).message}` }
	}
	const result = v.safeParse(schema, parsed)
	if (!result.success) {
		const issue = result.issues[0]
		const path = issue?.path?.map((p) => p.key).join('.') ?? '<root>'
		return { ok: false, error: `schema_invalid at ${path}: ${issue?.message ?? 'unknown'}` }
	}
	return { ok: true, msg: result.output }
}

export function parseMemberToHousehold(raw: string): ParseResult<MemberToHousehold> {
	return parseWithSchema(MemberToHouseholdSchema, raw) as ParseResult<MemberToHousehold>
}

export function parseHouseholdToMember(raw: string): ParseResult<HouseholdToMember> {
	return parseWithSchema(HouseholdToMemberSchema, raw) as ParseResult<HouseholdToMember>
}
