BEGIN;

-- FINAL DESTRUCTIVE CLEANUP
--
-- Run only after:
-- - quiet observation window is complete
-- - no new queue writes appear
-- - compatibility views are no longer needed
-- - archive tables remain intact and verified

DROP VIEW IF EXISTS claude.morning_queue;
DROP VIEW IF EXISTS claude.pending_confirms;
DROP VIEW IF EXISTS claude.mainbot_queue;

DROP TABLE IF EXISTS claude.morning_queue_legacy_live;
DROP TABLE IF EXISTS claude.pending_confirms_legacy_live;
DROP TABLE IF EXISTS claude.mainbot_queue_legacy_live;

COMMIT;
