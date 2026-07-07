CREATE SCHEMA IF NOT EXISTS sigma;

DO $$
BEGIN
  UPDATE sigma.vault_entries
  SET time_stage = 'dormant',
      meta = jsonb_set(
        COALESCE(meta, '{}'::jsonb),
        '{libraryCoords}',
        COALESCE(meta->'libraryCoords', '{}'::jsonb) || '{"time_stage":"dormant"}'::jsonb,
        true
      ),
      updated_at = NOW()
  WHERE time_stage = 'decayed'
     OR meta->'libraryCoords'->>'time_stage' = 'decayed';

  ALTER TABLE sigma.vault_entries
    DROP CONSTRAINT IF EXISTS vault_entries_time_stage_coord_check;
  ALTER TABLE sigma.vault_entries
    ADD CONSTRAINT vault_entries_time_stage_coord_check
    CHECK (time_stage IS NULL OR time_stage IN ('raw', 'digest', 'pattern', 'dormant', 'forgotten'));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_time_stage_age
  ON sigma.vault_entries (time_stage, created_at);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_merged_into
  ON sigma.vault_entries ((meta->>'merged_into'))
  WHERE meta ? 'merged_into';
