-- Luna RL/Sigma learning bridge schema hardening
-- 2026-05-27
--
-- Purpose:
--   Keep legacy strategy mutation writers and newer PPO/RL learning writers
--   compatible across fresh and already-bootstrapped databases.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.strategy_mutation_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  lifecycle_phase TEXT NOT NULL DEFAULT 'shadow',
  position_scope_key TEXT NOT NULL DEFAULT 'global',
  exchange TEXT NOT NULL DEFAULT 'unknown',
  symbol TEXT NOT NULL DEFAULT 'unknown',
  trade_mode TEXT NOT NULL DEFAULT 'normal',
  old_setup_type TEXT,
  new_setup_type TEXT,
  validity_score DOUBLE PRECISION,
  predictive_score DOUBLE PRECISION,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE investment.strategy_mutation_events
  ADD COLUMN IF NOT EXISTS position_scope_key TEXT,
  ADD COLUMN IF NOT EXISTS exchange TEXT,
  ADD COLUMN IF NOT EXISTS symbol TEXT,
  ADD COLUMN IF NOT EXISTS trade_mode TEXT,
  ADD COLUMN IF NOT EXISTS old_setup_type TEXT,
  ADD COLUMN IF NOT EXISTS new_setup_type TEXT,
  ADD COLUMN IF NOT EXISTS validity_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS predictive_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE investment.strategy_mutation_events
   SET position_scope_key = COALESCE(position_scope_key, 'global'),
       exchange = COALESCE(exchange, 'unknown'),
       symbol = COALESCE(symbol, 'unknown'),
       trade_mode = COALESCE(trade_mode, 'normal'),
       metadata = COALESCE(metadata, '{}'::jsonb)
 WHERE position_scope_key IS NULL
    OR exchange IS NULL
    OR symbol IS NULL
    OR trade_mode IS NULL
    OR metadata IS NULL;

ALTER TABLE investment.strategy_mutation_events
  ALTER COLUMN lifecycle_phase SET DEFAULT 'shadow',
  ALTER COLUMN position_scope_key SET DEFAULT 'global',
  ALTER COLUMN position_scope_key SET NOT NULL,
  ALTER COLUMN exchange SET DEFAULT 'unknown',
  ALTER COLUMN exchange SET NOT NULL,
  ALTER COLUMN symbol SET DEFAULT 'unknown',
  ALTER COLUMN symbol SET NOT NULL,
  ALTER COLUMN trade_mode SET DEFAULT 'normal',
  ALTER COLUMN trade_mode SET NOT NULL,
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_mutation_events_created
  ON investment.strategy_mutation_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_mutation_events_scope
  ON investment.strategy_mutation_events (position_scope_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_mutation_events_symbol
  ON investment.strategy_mutation_events (exchange, symbol, trade_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_mutation_events_type_phase
  ON investment.strategy_mutation_events (event_type, lifecycle_phase, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_to_action_map_mapper_symbol
  ON investment.feedback_to_action_map ((metadata->>'mapper'), (metadata->>'symbol'), applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_to_action_map_shadow_action
  ON investment.feedback_to_action_map ((metadata->>'actionType'), applied_at DESC)
  WHERE COALESCE(metadata->>'shadowOnly', 'false') = 'true';
