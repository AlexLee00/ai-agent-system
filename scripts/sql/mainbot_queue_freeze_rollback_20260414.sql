BEGIN;

-- Roll back the read-only freeze if legacy queue writes/updates must be
-- temporarily restored.

DROP VIEW IF EXISTS claude.morning_queue;
DROP VIEW IF EXISTS claude.pending_confirms;
DROP VIEW IF EXISTS claude.mainbot_queue;

ALTER TABLE IF EXISTS claude.morning_queue_legacy_live RENAME TO morning_queue;
ALTER TABLE IF EXISTS claude.pending_confirms_legacy_live RENAME TO pending_confirms;
ALTER TABLE IF EXISTS claude.mainbot_queue_legacy_live RENAME TO mainbot_queue;

COMMIT;
