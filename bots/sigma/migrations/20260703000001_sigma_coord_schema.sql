CREATE SCHEMA IF NOT EXISTS sigma;

ALTER TABLE sigma.vault_entries
  ADD COLUMN IF NOT EXISTS abstraction_level TEXT,
  ADD COLUMN IF NOT EXISTS time_stage TEXT,
  ADD COLUMN IF NOT EXISTS validation_state TEXT,
  ADD COLUMN IF NOT EXISTS prediction_state TEXT,
  ADD COLUMN IF NOT EXISTS prediction_horizon TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE sigma.vault_entries
    ADD CONSTRAINT vault_entries_abstraction_level_coord_check
    CHECK (abstraction_level IS NULL OR abstraction_level IN ('L0', 'L1', 'L2', 'L3'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE sigma.vault_entries
    ADD CONSTRAINT vault_entries_time_stage_coord_check
    CHECK (time_stage IS NULL OR time_stage IN ('raw', 'digest', 'pattern', 'dormant', 'forgotten'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE sigma.vault_entries
    ADD CONSTRAINT vault_entries_validation_state_coord_check
    CHECK (validation_state IS NULL OR validation_state IN ('unverified', 'observed', 'validated', 'contradicted', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE sigma.vault_entries
    ADD CONSTRAINT vault_entries_prediction_state_coord_check
    CHECK (prediction_state IS NULL OR prediction_state IN ('none', 'forward', 'due', 'resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_coords
  ON sigma.vault_entries (abstraction_level, time_stage, validation_state, prediction_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_prediction_horizon
  ON sigma.vault_entries (prediction_horizon)
  WHERE prediction_horizon IS NOT NULL;
