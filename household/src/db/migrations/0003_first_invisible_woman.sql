ALTER TABLE `task_jobs` ADD `pr_author_login` text;--> statement-breakpoint
ALTER TABLE `repo_bindings` DROP COLUMN `github_pat_enc`;