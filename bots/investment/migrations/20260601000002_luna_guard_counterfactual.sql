-- Luna guard-blocked counterfactual SHADOW results.
-- 가드/entry-trigger 동작은 변경하지 않고, 차단된 트리거의 가상 triple-barrier 결과만 기록한다.

CREATE TABLE IF NOT EXISTS investment.luna_guard_counterfactual (
  id                BIGSERIAL PRIMARY KEY,
  trigger_id        TEXT NOT NULL UNIQUE,
  symbol            TEXT NOT NULL,
  exchange          TEXT,
  reason            TEXT NOT NULL,
  blocked_at        TIMESTAMPTZ NOT NULL,
  entry_price       DOUBLE PRECISION,
  take_profit       DOUBLE PRECISION,
  stop_loss         DOUBLE PRECISION,
  time_barrier_at   TIMESTAMPTZ,
  timeframe         TEXT NOT NULL,
  bars_evaluated    INTEGER NOT NULL DEFAULT 0,
  virtual_label     INTEGER,
  virtual_return    DOUBLE PRECISION,
  exit_price        DOUBLE PRECISION,
  exit_ts           TIMESTAMPTZ,
  exit_reason       TEXT,
  ohlcv_status      TEXT NOT NULL DEFAULT 'pending',
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_guard_counterfactual_reason
  ON investment.luna_guard_counterfactual (reason, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_guard_counterfactual_symbol
  ON investment.luna_guard_counterfactual (symbol, computed_at DESC);

COMMENT ON TABLE investment.luna_guard_counterfactual IS
  'SHADOW: entry trigger guard-blocked trades counterfactual triple-barrier outcomes';
