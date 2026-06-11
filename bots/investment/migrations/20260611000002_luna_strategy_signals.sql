-- Luna P1-4: C3 strategy families shadow signals
-- Additive only. Runtime decision paths do not consume this table.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_strategy_signals (
  id           BIGSERIAL PRIMARY KEY,
  market       TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  symbol       TEXT NOT NULL,
  family       TEXT NOT NULL CHECK (family IN ('turtle_breakout', 'testah_pullback')),
  signal_type  TEXT NOT NULL CHECK (signal_type IN ('entry', 'exit', 'invalidate')),
  candle_ts    TIMESTAMPTZ NOT NULL,
  price        NUMERIC,
  stop         NUMERIC,
  target       NUMERIC,
  rr           NUMERIC,
  regime       JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched      BOOLEAN,
  rule_version TEXT NOT NULL DEFAULT 'v1',
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investment.luna_strategy_signals
  ADD COLUMN IF NOT EXISTS market TEXT,
  ADD COLUMN IF NOT EXISTS symbol TEXT,
  ADD COLUMN IF NOT EXISTS family TEXT,
  ADD COLUMN IF NOT EXISTS signal_type TEXT,
  ADD COLUMN IF NOT EXISTS candle_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS price NUMERIC,
  ADD COLUMN IF NOT EXISTS stop NUMERIC,
  ADD COLUMN IF NOT EXISTS target NUMERIC,
  ADD COLUMN IF NOT EXISTS rr NUMERIC,
  ADD COLUMN IF NOT EXISTS regime JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS matched BOOLEAN,
  ADD COLUMN IF NOT EXISTS rule_version TEXT DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_luna_strategy_signals_unique
  ON investment.luna_strategy_signals (symbol, family, candle_ts, signal_type);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_signals_market_family_time
  ON investment.luna_strategy_signals (market, family, candle_ts DESC);

WITH seed(key, value, scope, tier, effective_from, evidence, changed_by) AS (
  VALUES
    ('c3.turtle.entry_lookback', '20'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle breakout entry lookback', 'meeting'),
    ('c3.turtle.exit_lookback', '10'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle breakout exit lookback', 'meeting'),
    ('c3.turtle.atr_period', '20'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle breakout ATR period', 'meeting'),
    ('c3.turtle.atr_mult', '2'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle breakout ATR multiplier', 'meeting'),
    ('c3.turtle.ma_filter', '200'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle breakout MA filter', 'meeting'),
    ('c3.testah.ma_fast', '5'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 Testah fast MA', 'meeting'),
    ('c3.testah.ma_mid', '25'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 Testah mid MA', 'meeting'),
    ('c3.testah.ma_slow', '75'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 Testah slow MA', 'meeting'),
    ('c3.testah.pullback_window', '5'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 Testah pullback window', 'meeting'),
    ('c3.regime_match.turtle', '["bull","volatile"]'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 turtle regime match set', 'meeting'),
    ('c3.regime_match.testah', '["bull"]'::jsonb, 'strategy_family', 'auto', NOW(), 'LUNA P1-4 C3 Testah regime match set', 'meeting')
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

COMMENT ON TABLE investment.luna_strategy_signals IS
  'Luna P1-4 shadow-only C3 strategy family signals. Runtime trading decisions do not consume this table.';
