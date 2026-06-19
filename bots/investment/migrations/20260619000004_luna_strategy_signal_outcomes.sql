-- Luna C8: shadow strategy signal outcome feedback.
-- Additive only. Trading decisions and trade_journal do not consume this table.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_strategy_signal_outcomes (
  id                 BIGSERIAL PRIMARY KEY,
  signal_id          BIGINT NOT NULL REFERENCES investment.luna_strategy_signals(id) ON DELETE CASCADE,
  family             TEXT NOT NULL,
  regime_dominant    TEXT,
  market             TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  symbol             TEXT NOT NULL,
  candle_ts          TIMESTAMPTZ NOT NULL,
  entry_price        NUMERIC,
  target_price       NUMERIC,
  stop_price         NUMERIC,
  rr_planned         NUMERIC,
  outcome            TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'expired', 'open')),
  exit_reason        TEXT NOT NULL CHECK (exit_reason IN ('target_hit', 'stop_hit', 'time_expired', 'still_open')),
  realized_r         NUMERIC,
  realized_pnl_pct   NUMERIC,
  bars_evaluated     INTEGER NOT NULL DEFAULT 0,
  last_price         NUMERIC,
  evaluated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only        BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_signal_outcomes_family_regime
  ON investment.luna_strategy_signal_outcomes(family, regime_dominant);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_signal_outcomes_outcome
  ON investment.luna_strategy_signal_outcomes(outcome);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_signal_outcomes_market_symbol
  ON investment.luna_strategy_signal_outcomes(market, symbol, evaluated_at DESC);

COMMENT ON TABLE investment.luna_strategy_signal_outcomes IS
  'Luna C8 shadow/advisory outcomes for unfilled C3 strategy signals. This table is not consumed by live trading.';
