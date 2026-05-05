ALTER TABLE `tasks` ADD `previous_member_id` text REFERENCES members(member_id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_author_login` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_notified_status` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `github_issue_number` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `github_issue_url` text;--> statement-breakpoint
CREATE INDEX `tasks_pr_url_idx` ON `tasks` (`pr_url`);--> statement-breakpoint
CREATE INDEX `tasks_issue_idx` ON `tasks` (`repo`,`github_issue_number`);--> statement-breakpoint
-- Backfill the new columns from `metadata` JSON for existing rows. After this
-- runs, new code reads/writes the dedicated columns and the JSON keys are no
-- longer authoritative.
UPDATE `tasks` SET `github_issue_number` = CAST(json_extract(`metadata`, '$.github_issue_number') AS INTEGER) WHERE `metadata` IS NOT NULL AND json_extract(`metadata`, '$.github_issue_number') IS NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `github_issue_url` = json_extract(`metadata`, '$.github_issue_url') WHERE `metadata` IS NOT NULL AND json_extract(`metadata`, '$.github_issue_url') IS NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `pr_author_login` = json_extract(`metadata`, '$.pr_author_login') WHERE `metadata` IS NOT NULL AND json_extract(`metadata`, '$.pr_author_login') IS NOT NULL;--> statement-breakpoint
-- Existing tasks have already had their notifications fired (or not). Mark
-- them as "already notified at the current status" so the tracker doesn't
-- double-fire after the upgrade.
UPDATE `tasks` SET `last_notified_status` = `status`;--> statement-breakpoint
-- Existing in-review/awaiting-merge tasks: their `assigned_member_id` is the
-- last implementer. Copy it into `previous_member_id` so the dispatcher's
-- preferred-member bias keeps working immediately after upgrade for any
-- changes_requested that fires next.
UPDATE `tasks` SET `previous_member_id` = `assigned_member_id` WHERE `status` IN ('in-review','awaiting-merge');