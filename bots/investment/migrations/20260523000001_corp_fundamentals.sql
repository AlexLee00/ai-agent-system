CREATE TABLE IF NOT EXISTS investment.corp_fundamentals (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code              TEXT NOT NULL,
  corp_code               TEXT,
  company_name            TEXT,
  bsns_year               TEXT,
  reprt_code              TEXT,
  per                     NUMERIC,
  pbr                     NUMERIC,
  roe                     NUMERIC,
  roa                     NUMERIC,
  eps                     NUMERIC,
  bps                     NUMERIC,
  market_cap              BIGINT,
  listed_shares           BIGINT,
  debt_ratio              NUMERIC,
  current_ratio           NUMERIC,
  operating_margin        NUMERIC,
  net_margin              NUMERIC,
  revenue_growth          NUMERIC,
  operating_income_growth NUMERIC,
  revenue_5y              JSONB DEFAULT '{}'::jsonb,
  op_income_5y            JSONB DEFAULT '{}'::jsonb,
  net_income_5y           JSONB DEFAULT '{}'::jsonb,
  factor_scores           JSONB DEFAULT '{}'::jsonb,
  source                  TEXT DEFAULT 'opendart',
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_corp_fundamentals_stock_period
  ON investment.corp_fundamentals(stock_code, bsns_year, reprt_code);

CREATE INDEX IF NOT EXISTS idx_corp_fundamentals_stock_updated
  ON investment.corp_fundamentals(stock_code, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_corp_fundamentals_factor_scores
  ON investment.corp_fundamentals USING GIN (factor_scores);
