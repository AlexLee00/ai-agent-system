BEGIN;

-- Freeze live legacy queue tables by renaming them and exposing read-only
-- compatibility views under the original names.
--
-- Intended effect:
-- - current SELECT queries can keep working for a short transition window
-- - INSERT / UPDATE / DELETE against the original names fail fast
-- - historical rows remain available in-place
--
-- Apply only after:
-- - MAINBOT_QUEUE_CONSUMER_ENABLED=false is stable in OPS
-- - MAINBOT_QUEUE_PUBLISH_ENABLED remains disabled by default
-- - archive tables have already been created and row-count verified

ALTER TABLE claude.mainbot_queue RENAME TO mainbot_queue_legacy_live;
ALTER TABLE claude.pending_confirms RENAME TO pending_confirms_legacy_live;
ALTER TABLE claude.morning_queue RENAME TO morning_queue_legacy_live;

CREATE VIEW claude.mainbot_queue AS
SELECT * FROM claude.mainbot_queue_legacy_live;

CREATE VIEW claude.pending_confirms AS
SELECT * FROM claude.pending_confirms_legacy_live;

CREATE VIEW claude.morning_queue AS
SELECT * FROM claude.morning_queue_legacy_live;

COMMENT ON VIEW claude.mainbot_queue IS
  'Legacy read-only compatibility view created by mainbot_queue freeze step (2026-04-14).';
COMMENT ON VIEW claude.pending_confirms IS
  'Legacy read-only compatibility view created by mainbot_queue freeze step (2026-04-14).';
COMMENT ON VIEW claude.morning_queue IS
  'Legacy read-only compatibility view created by mainbot_queue freeze step (2026-04-14).';

COMMIT;
