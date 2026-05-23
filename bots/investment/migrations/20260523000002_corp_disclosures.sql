CREATE TABLE IF NOT EXISTS investment.corp_disclosures (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corp_code        TEXT,
  stock_code       TEXT,
  company_name     TEXT,
  corp_cls         TEXT,
  rcept_no         TEXT NOT NULL,
  rcept_dt         DATE,
  submission_dt    TIMESTAMPTZ,
  report_nm        TEXT NOT NULL,
  report_type      TEXT DEFAULT 'general',
  importance_score INTEGER DEFAULT 1,
  llm_summary      TEXT,
  keywords         JSONB DEFAULT '[]'::jsonb,
  raw_data         JSONB DEFAULT '{}'::jsonb,
  source           TEXT DEFAULT 'opendart',
  collected_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rcept_no)
);

CREATE INDEX IF NOT EXISTS idx_corp_disclosures_date_importance
  ON investment.corp_disclosures(rcept_dt DESC, importance_score DESC);

CREATE INDEX IF NOT EXISTS idx_corp_disclosures_corp_date
  ON investment.corp_disclosures(corp_code, rcept_dt DESC);

CREATE INDEX IF NOT EXISTS idx_corp_disclosures_keywords
  ON investment.corp_disclosures USING GIN (keywords);
