-- Luna P1-5: C4 entry preflight + loss circuit shadow logs
-- Additive only. Runtime trading decisions do not consume these tables.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_entry_preflight_log (
  id                 BIGSERIAL PRIMARY KEY,
  strategy_signal_id BIGINT,
  market             TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  symbol             TEXT NOT NULL,
  family             TEXT NOT NULL,
  candle_ts          TIMESTAMPTZ,
  decision           TEXT NOT NULL CHECK (decision IN ('pass', 'block', 'pass_with_skips')),
  gates              JSONB NOT NULL DEFAULT '[]'::jsonb,
  regime             JSONB NOT NULL DEFAULT '{}'::jsonb,
  rr                 NUMERIC,
  evaluated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_symbol_time
  ON investment.luna_entry_preflight_log(symbol, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_decision_time
  ON investment.luna_entry_preflight_log(decision, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_family_time
  ON investment.luna_entry_preflight_log(market, family, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS investment.luna_circuit_locks (
  id           BIGSERIAL PRIMARY KEY,
  market       TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  symbol       TEXT,
  side         TEXT,
  level        TEXT NOT NULL CHECK (level IN ('market', 'symbol', 'side')),
  circuit      TEXT NOT NULL,
  locked       BOOLEAN NOT NULL DEFAULT FALSE,
  reason       TEXT,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  lock_until   TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_market_time
  ON investment.luna_circuit_locks(market, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_symbol_time
  ON investment.luna_circuit_locks(symbol, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_circuit_time
  ON investment.luna_circuit_locks(circuit, evaluated_at DESC);

WITH seed(key, value, scope, tier, effective_from, evidence, changed_by) AS (
  VALUES
    ('c4.min_rr', '2.0'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 C4 minimum risk-reward', 'meeting'),
    ('c4.e_min_samples', '30'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 C4 expectancy minimum samples', 'meeting'),
    ('c4.sideways_block_threshold', '0.5'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 C4 sideways block threshold', 'meeting'),
    ('c4.circuit_lookback_min', '1440'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 loss circuit lookback minutes', 'meeting'),
    ('c4.circuit_trade_limit', '4'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 StoplossGuard trade limit', 'meeting'),
    ('c4.circuit_stop_duration_min', '1440'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 StoplossGuard stop duration minutes', 'meeting'),
    ('c4.symbol_cooldown_candles', '2'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 symbol cooldown candles', 'meeting'),
    ('c4.low_profit_lookback_days', '14'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-5 low-profit symbol lookback days', 'meeting'),
    ('c4.min_liquidity', '{"crypto":1000000,"domestic":1000000000,"overseas":5000000}'::jsonb, 'market', 'auto', NOW(), 'LUNA P1-5 market minimum liquidity defaults', 'meeting')
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

COMMENT ON TABLE investment.luna_entry_preflight_log IS
  'Luna P1-5 shadow-only C4 entry preflight evaluations for C3 strategy signals.';

COMMENT ON TABLE investment.luna_circuit_locks IS
  'Luna P1-5 shadow-only loss-frequency circuit lock evaluations. Trading decisions do not consume this table.';
