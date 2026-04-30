-- Luna Phase B: additive backtest run ledger.
CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  layer INTEGER NOT NULL CHECK (layer IN (1, 2, 3)),
  sharpe NUMERIC,
  sortino NUMERIC,
  hit_rate NUMERIC,
  max_dd NUMERIC,
  total_return NUMERIC,
  trades_count INTEGER,
  params JSONB DEFAULT '{}'::jsonb,
  result JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_scope
  ON investment.backtest_runs(symbol, market, strategy_name, layer, created_at DESC);
