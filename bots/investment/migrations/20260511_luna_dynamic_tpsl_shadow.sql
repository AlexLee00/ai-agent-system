-- Luna Hybrid Phase 3 — Dynamic TP/SL Shadow

CREATE TABLE IF NOT EXISTS investment.luna_dynamic_tpsl_shadow (
  id               BIGSERIAL PRIMARY KEY,
  trigger_id       TEXT,
  symbol           TEXT NOT NULL,
  exchange         TEXT NOT NULL DEFAULT 'binance',
  market           TEXT NOT NULL DEFAULT 'crypto',
  entry_price      NUMERIC(24,10),
  side             TEXT NOT NULL DEFAULT 'BUY',
  rule_tp_pct      NUMERIC(8,6),
  rule_sl_pct      NUMERIC(8,6),
  rule_tp_price    NUMERIC(24,10),
  rule_sl_price    NUMERIC(24,10),
  llm_tp_pct       NUMERIC(8,6),
  llm_sl_pct       NUMERIC(8,6),
  llm_tp_price     NUMERIC(24,10),
  llm_sl_price     NUMERIC(24,10),
  rr_ratio         NUMERIC(8,4),
  reasoning        TEXT,
  risk_assessment  JSONB DEFAULT '{}'::jsonb,
  rule_tpsl        JSONB DEFAULT '{}'::jsonb,
  context_evidence JSONB DEFAULT '{}'::jsonb,
  shadow_only      BOOLEAN NOT NULL DEFAULT true,
  match            BOOLEAN DEFAULT false,
  observed_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE investment.luna_dynamic_tpsl_shadow
  ADD COLUMN IF NOT EXISTS context_evidence JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_luna_dynamic_tpsl_shadow_trigger_observed
  ON investment.luna_dynamic_tpsl_shadow (trigger_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_dynamic_tpsl_shadow_symbol_observed
  ON investment.luna_dynamic_tpsl_shadow (exchange, symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_dynamic_tpsl_shadow_match
  ON investment.luna_dynamic_tpsl_shadow (match, observed_at DESC);
