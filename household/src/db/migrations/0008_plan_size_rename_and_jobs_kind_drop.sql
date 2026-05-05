-- Protocol 3.0.0 cleanup, second wave.
--
-- 1) Rename `tasks.estimate_size` / `tasks.estimate_blockers` →
--    `tasks.plan_size` / `tasks.plan_blockers`. The columns existed for the
--    old (now-removed) `estimate` skill / kind, but they've been carrying
--    triage's plan output for a while — names lied. Now they line up with
--    what they actually store: the size + blockers a triage agent posted in
--    its plan comment, propagated to the spawned implement task.
--
-- 2) Drop `task_jobs.kind`. The column existed in case we ever wanted job
--    kinds other than `review`, but every code path only ever wrote
--    `'review'`. Hypothetical future job kinds can re-add the column when
--    they actually exist.
ALTER TABLE `tasks` RENAME COLUMN `estimate_size` TO `plan_size`;
--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `estimate_blockers` TO `plan_blockers`;
--> statement-breakpoint
ALTER TABLE `task_jobs` DROP COLUMN `kind`;
