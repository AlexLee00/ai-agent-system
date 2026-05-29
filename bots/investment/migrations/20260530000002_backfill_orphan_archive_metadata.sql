-- Backfill archive metadata for the orphan paper positions archive.
-- This is safe/idempotent: it only adds metadata columns and fills NULL reasons.

BEGIN;

ALTER TABLE investment.positions_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE investment.position_strategy_profiles_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS archive_reason text;

UPDATE investment.positions_archive
SET
  archived_at = COALESCE(archived_at, NOW()),
  archive_reason = COALESCE(archive_reason, 'orphan_paper_position_20260530')
WHERE archive_reason IS NULL;

UPDATE investment.position_strategy_profiles_archive
SET
  archived_at = COALESCE(archived_at, NOW()),
  archive_reason = COALESCE(archive_reason, 'orphan_paper_position_20260530')
WHERE archive_reason IS NULL;

COMMIT;
