UPDATE `repo_bindings` SET `github_pat_enc` = 'xxx' WHERE `github_pat_enc` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repo_bindings` (
	`repo` text PRIMARY KEY NOT NULL,
	`webhook_secret_enc` text NOT NULL,
	`github_pat_enc` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_repo_bindings`("repo", "webhook_secret_enc", "github_pat_enc", "created_at", "updated_at") SELECT "repo", "webhook_secret_enc", "github_pat_enc", "created_at", "updated_at" FROM `repo_bindings`;--> statement-breakpoint
DROP TABLE `repo_bindings`;--> statement-breakpoint
ALTER TABLE `__new_repo_bindings` RENAME TO `repo_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;