CREATE TABLE IF NOT EXISTS investment.korean_factor_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code       TEXT NOT NULL,
  company_name     TEXT,
  factor_name      TEXT NOT NULL,
  factor_value     NUMERIC,
  rank             INTEGER,
  decile           INTEGER,
  calculation_date DATE NOT NULL DEFAULT CURRENT_DATE,
  metadata         JSONB DEFAULT '{}'::jsonb,
  source           TEXT DEFAULT 'luna_korean_factor_model',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_korean_factor_log_date_factor_decile
  ON investment.korean_factor_log(calculation_date, factor_name, decile);

CREATE INDEX IF NOT EXISTS idx_korean_factor_log_stock_date
  ON investment.korean_factor_log(stock_code, calculation_date DESC);
