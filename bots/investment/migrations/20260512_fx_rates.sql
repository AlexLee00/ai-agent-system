-- investment.fx_rates — 환율 관리 테이블
-- CODEX_LUNA_TRADES_USD_NORMALIZATION Task A
-- 2026-05-12

CREATE TABLE IF NOT EXISTS investment.fx_rates (
  base_currency  TEXT        NOT NULL,
  quote_currency TEXT        NOT NULL DEFAULT 'USD',
  rate           NUMERIC(12,6) NOT NULL,  -- 1 base = X quote (e.g. 1 KRW = 0.000735 USD)
  inverse_rate   NUMERIC(12,4) NOT NULL,  -- 1 quote = X base (e.g. 1 USD = 1360 KRW)
  source         TEXT        DEFAULT 'manual',
  effective_date DATE        NOT NULL,
  PRIMARY KEY (base_currency, quote_currency, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_date
  ON investment.fx_rates (effective_date DESC);

-- 초기 환율 (2026-05-12 기준)
INSERT INTO investment.fx_rates
  (base_currency, quote_currency, rate, inverse_rate, source, effective_date)
VALUES
  ('KRW',  'USD', 0.000735, 1360.00, 'manual_init', '2026-05-12'),
  ('USDT', 'USD', 1.000000,    1.00, 'manual_init', '2026-05-12')
ON CONFLICT DO NOTHING;
