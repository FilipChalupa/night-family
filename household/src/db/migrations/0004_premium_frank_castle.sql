CREATE TABLE `members` (
	`member_id` text PRIMARY KEY NOT NULL,
	`member_name` text NOT NULL,
	`display_name` text NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`repos` text,
	`provider` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`worker_profile` text DEFAULT '' NOT NULL,
	`protocol_version` text DEFAULT '' NOT NULL,
	`token_id` text,
	`first_connected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_connected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_disconnected_at` integer
);
--> statement-breakpoint
CREATE INDEX `members_last_seen_idx` ON `members` (`last_seen_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `members` (
	`member_id`, `member_name`, `display_name`,
	`first_connected_at`, `last_connected_at`, `last_seen_at`, `last_disconnected_at`
)
SELECT
	`assigned_member_id`,
	COALESCE(`assigned_member_name`, 'unknown'),
	COALESCE(`assigned_member_name`, 'unknown'),
	MIN(`created_at`), MAX(`updated_at`), MAX(`updated_at`), MAX(`updated_at`)
FROM `tasks`
WHERE `assigned_member_id` IS NOT NULL
GROUP BY `assigned_member_id`;--> statement-breakpoint
INSERT OR IGNORE INTO `members` (
	`member_id`, `member_name`, `display_name`,
	`first_connected_at`, `last_connected_at`, `last_seen_at`, `last_disconnected_at`
)
SELECT
	`assigned_member_id`,
	COALESCE(`assigned_member_name`, 'unknown'),
	COALESCE(`assigned_member_name`, 'unknown'),
	MIN(`created_at`), MAX(`updated_at`), MAX(`updated_at`), MAX(`updated_at`)
FROM `task_jobs`
WHERE `assigned_member_id` IS NOT NULL
GROUP BY `assigned_member_id`;--> statement-breakpoint
INSERT OR IGNORE INTO `members` (
	`member_id`, `member_name`, `display_name`,
	`first_connected_at`, `last_connected_at`, `last_seen_at`, `last_disconnected_at`
)
SELECT
	`member_id`, 'unknown', 'unknown',
	MIN(`ts`), MAX(`ts`), MAX(`ts`), MAX(`ts`)
FROM `task_events`
WHERE `member_id` IS NOT NULL
GROUP BY `member_id`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`session_id` text,
	`member_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`member_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_task_events`("task_id", "seq", "ts", "session_id", "member_id", "kind", "payload") SELECT "task_id", "seq", "ts", "session_id", "member_id", "kind", "payload" FROM `task_events`;--> statement-breakpoint
DROP TABLE `task_events`;--> statement-breakpoint
ALTER TABLE `__new_task_events` RENAME TO `task_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_events_ts_idx` ON `task_events` (`ts`);--> statement-breakpoint
CREATE TABLE `__new_task_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text DEFAULT 'review' NOT NULL,
	`status` text NOT NULL,
	`assigned_session_id` text,
	`assigned_member_id` text,
	`pr_author_login` text,
	`verdict` text,
	`result` text,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`assigned_member_id`) REFERENCES `members`(`member_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_task_jobs`("id", "task_id", "kind", "status", "assigned_session_id", "assigned_member_id", "pr_author_login", "verdict", "result", "failure_reason", "created_at", "updated_at") SELECT "id", "task_id", "kind", "status", "assigned_session_id", "assigned_member_id", "pr_author_login", "verdict", "result", "failure_reason", "created_at", "updated_at" FROM `task_jobs`;--> statement-breakpoint
DROP TABLE `task_jobs`;--> statement-breakpoint
ALTER TABLE `__new_task_jobs` RENAME TO `task_jobs`;--> statement-breakpoint
CREATE INDEX `task_jobs_task_idx` ON `task_jobs` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_jobs_status_idx` ON `task_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`estimate_size` text,
	`estimate_blockers` text,
	`pr_url` text,
	`assigned_session_id` text,
	`assigned_member_id` text,
	`failure_reason` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`next_retry_at` integer,
	`metadata` text,
	FOREIGN KEY (`assigned_member_id`) REFERENCES `members`(`member_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "repo", "kind", "title", "description", "status", "estimate_size", "estimate_blockers", "pr_url", "assigned_session_id", "assigned_member_id", "failure_reason", "retry_count", "created_at", "updated_at", "next_retry_at", "metadata") SELECT "id", "repo", "kind", "title", "description", "status", "estimate_size", "estimate_blockers", "pr_url", "assigned_session_id", "assigned_member_id", "failure_reason", "retry_count", "created_at", "updated_at", "next_retry_at", "metadata" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_repo_idx` ON `tasks` (`repo`);