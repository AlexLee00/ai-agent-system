-- Luna P1-1: C17 parameter store + C15 component registry
-- Shadow-only infrastructure. Existing runtime decision paths continue to use
-- env/runtime-config until a later explicit consumer migration.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_parameter_store (
  id             BIGSERIAL PRIMARY KEY,
  key            TEXT NOT NULL,
  value          JSONB NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'global'
                   CHECK (scope IN ('global', 'market', 'strategy_family')),
  tier           TEXT NOT NULL
                   CHECK (tier IN ('auto', 'approve', 'immutable')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence       TEXT,
  changed_by     TEXT NOT NULL DEFAULT 'system'
                   CHECK (changed_by IN ('system', 'meeting', 'master')),
  prev_value     JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investment.luna_parameter_store
  ADD COLUMN IF NOT EXISTS key TEXT,
  ADD COLUMN IF NOT EXISTS value JSONB,
  ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS tier TEXT,
  ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS evidence TEXT,
  ADD COLUMN IF NOT EXISTS changed_by TEXT DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS prev_value JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_luna_parameter_store_latest
  ON investment.luna_parameter_store (key, scope, effective_from DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_luna_parameter_store_created
  ON investment.luna_parameter_store (created_at DESC);

CREATE OR REPLACE FUNCTION investment.luna_parameter_store_prevent_update_or_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'investment.luna_parameter_store is append-only; insert a new row instead of updating or deleting';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_luna_parameter_store_prevent_update
  ON investment.luna_parameter_store;
DROP TRIGGER IF EXISTS trg_luna_parameter_store_prevent_update_or_delete
  ON investment.luna_parameter_store;

CREATE TRIGGER trg_luna_parameter_store_prevent_update_or_delete
BEFORE UPDATE OR DELETE ON investment.luna_parameter_store
FOR EACH ROW EXECUTE FUNCTION investment.luna_parameter_store_prevent_update_or_delete();

CREATE TABLE IF NOT EXISTS investment.luna_component_registry (
  component          TEXT PRIMARY KEY,
  current_mode       TEXT NOT NULL,
  target_mode        TEXT NOT NULL,
  promotion_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_count       INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'stalled', 'proposed', 'promoted', 'halted')),
  last_evaluated_at  TIMESTAMPTZ,
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes              TEXT
);

ALTER TABLE investment.luna_component_registry
  ADD COLUMN IF NOT EXISTS current_mode TEXT,
  ADD COLUMN IF NOT EXISTS target_mode TEXT,
  ADD COLUMN IF NOT EXISTS promotion_criteria JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sample_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS idx_luna_component_registry_status
  ON investment.luna_component_registry (status, last_evaluated_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_luna_component_registry_registered
  ON investment.luna_component_registry (registered_at DESC);

WITH seed(key, value, scope, tier, effective_from, evidence, changed_by) AS (
  VALUES
    ('g0.market_gate.full_threshold', '70'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 G0 full threshold', 'meeting'),
    ('g0.market_gate.reduced_threshold', '40'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 G0 reduced threshold', 'meeting'),
    ('g0.market_gate.reduced_size_multiplier', '0.6'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 reduced sizing multiplier', 'meeting'),
    ('limits.position.max_open_cap', '30'::jsonb, 'global', 'approve', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 limit cap', 'meeting'),
    ('stage_a.duration_weeks', '4'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 Stage A duration', 'meeting'),
    ('stage_a.min_signals_per_strategy_family', '30'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 Stage A sample floor', 'meeting'),
    ('stage_a.promotion_target', '"virtual_expectancy_beats_live"'::jsonb, 'global', 'auto', NOW(), 'LUNA_OPTIMAL_REDESIGN §7 Stage A E superiority target', 'meeting')
)
INSERT INTO investment.luna_parameter_store (key, value, scope, tier, effective_from, evidence, changed_by)
SELECT key, value, scope, tier, effective_from, evidence, changed_by
  FROM seed
 WHERE NOT EXISTS (
   SELECT 1
     FROM investment.luna_parameter_store existing
    WHERE existing.key = seed.key
      AND existing.scope = seed.scope
      AND existing.evidence = seed.evidence
      AND existing.effective_from <= NOW()
 );

COMMENT ON TABLE investment.luna_parameter_store IS
  'Luna C17 append-only parameter store. Runtime consumers stay on env/runtime-config until explicitly migrated.';

COMMENT ON TABLE investment.luna_component_registry IS
  'Luna C15 shadow component registry and promotion proposal scaffold.';
