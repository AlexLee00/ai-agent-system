-- Luna vault shadow outcome attribution.
-- trade_journal/signals/pattern/shadow/curriculum 테이블은 읽기 전용이며,
-- 이 평가 테이블만 C1 결과를 기록한다.

CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_eval (
  id                   BIGSERIAL PRIMARY KEY,
  shadow_id            BIGINT REFERENCES investment.luna_vault_shadow_adjustments(id) ON DELETE CASCADE,
  pattern_key          TEXT NOT NULL,
  market               TEXT,
  regime               TEXT,
  eval_window_start    BIGINT NOT NULL,
  eval_window_end      BIGINT NOT NULL,
  post_trade_count     INTEGER NOT NULL DEFAULT 0,
  post_avg_pnl         DOUBLE PRECISION,
  base_adjustment_type TEXT NOT NULL,
  vault_shadow_type    TEXT,
  base_correct         BOOLEAN,
  vault_correct        BOOLEAN,
  evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (shadow_id, eval_window_start, eval_window_end)
);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_pattern
  ON investment.luna_vault_shadow_eval (pattern_key, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_evaluated
  ON investment.luna_vault_shadow_eval (evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_eval_market
  ON investment.luna_vault_shadow_eval (market, evaluated_at DESC);

COMMENT ON TABLE investment.luna_vault_shadow_eval IS
  'SHADOW C1: outcome attribution for vault shadow adjustments using post-decision trade_journal PnL';
