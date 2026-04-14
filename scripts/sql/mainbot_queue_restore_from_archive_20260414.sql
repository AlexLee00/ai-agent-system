BEGIN;

-- RESTORE FROM ARCHIVE
--
-- Use only if legacy queue tables must be temporarily reconstructed after
-- final destructive cleanup.

CREATE TABLE IF NOT EXISTS claude.mainbot_queue_legacy_live AS
SELECT * FROM claude.mainbot_queue_archive_20260414;

CREATE TABLE IF NOT EXISTS claude.pending_confirms_legacy_live AS
SELECT * FROM claude.pending_confirms_archive_20260414;

CREATE TABLE IF NOT EXISTS claude.morning_queue_legacy_live AS
SELECT * FROM claude.morning_queue_archive_20260414;

CREATE OR REPLACE VIEW claude.mainbot_queue AS
SELECT * FROM claude.mainbot_queue_legacy_live;

CREATE OR REPLACE VIEW claude.pending_confirms AS
SELECT * FROM claude.pending_confirms_legacy_live;

CREATE OR REPLACE VIEW claude.morning_queue AS
SELECT * FROM claude.morning_queue_legacy_live;

COMMIT;
