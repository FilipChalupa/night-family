CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_enc` text NOT NULL,
	`subscribed_events` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`redirect_to` text
);
--> statement-breakpoint
CREATE TABLE `repo_bindings` (
	`repo` text PRIMARY KEY NOT NULL,
	`webhook_secret_enc` text NOT NULL,
	`github_pat_enc` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_username` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`csrf_token` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`session_id` text,
	`member_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`task_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `task_events_ts_idx` ON `task_events` (`ts`);--> statement-breakpoint
CREATE TABLE `tasks` (
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
	`assigned_member_name` text,
	`failure_reason` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`next_retry_at` integer,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_repo_idx` ON `tasks` (`repo`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`event` text NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`processed_at` integer,
	`error` text
);
