CREATE TABLE `task_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text DEFAULT 'review' NOT NULL,
	`status` text NOT NULL,
	`assigned_session_id` text,
	`assigned_member_id` text,
	`assigned_member_name` text,
	`verdict` text,
	`result` text,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_jobs_task_idx` ON `task_jobs` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_jobs_status_idx` ON `task_jobs` (`status`);