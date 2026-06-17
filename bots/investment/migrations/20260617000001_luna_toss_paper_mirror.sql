-- Luna TOSS-D: S1 paper-mirror shadow log
-- Additive only. No live order execution consumes this table.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_toss_paper_mirror_log (
  id                 BIGSERIAL PRIMARY KEY,
  preflight_log_id   BIGINT,
  strategy_signal_id BIGINT,
  market             TEXT NOT NULL CHECK (market IN ('domestic', 'overseas')),
  symbol             TEXT NOT NULL,
  side               TEXT NOT NULL DEFAULT 'buy',
  quantity           NUMERIC,
  would_place        BOOLEAN NOT NULL DEFAULT TRUE,
  placed             BOOLEAN NOT NULL DEFAULT FALSE,
  stage              TEXT NOT NULL DEFAULT 's1_paper_mirror',
  toss_verify        JSONB NOT NULL DEFAULT '{}'::jsonb,
  balance_shadow     JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence           JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_luna_toss_paper_mirror_symbol_time
  ON investment.luna_toss_paper_mirror_log(symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_toss_paper_mirror_market_time
  ON investment.luna_toss_paper_mirror_log(market, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_toss_paper_mirror_stage_time
  ON investment.luna_toss_paper_mirror_log(stage, observed_at DESC);

COMMENT ON TABLE investment.luna_toss_paper_mirror_log IS
  'Luna TOSS-D S1 paper-mirror shadow-only records. placed is always false before TOSS-E.';
