-- Protocol 3.0.0 dropped `estimate` as a Skill / TaskKind and `estimating` /
-- `new` from TaskStatus. Any rows left in the DB with those values are dead
-- weight: the dispatcher won't pick them up (kind not in current acceptable
-- set, status not in the new transition table) and the UI renders them with
-- a blank chip. Sweep them out so the table reflects current semantics.
DELETE FROM `tasks` WHERE `kind` = 'estimate' OR `status` IN ('estimating', 'new');
