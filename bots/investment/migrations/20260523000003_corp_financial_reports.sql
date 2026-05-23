CREATE TABLE IF NOT EXISTS investment.corp_financial_reports (
  corp_code           TEXT NOT NULL,
  stock_code          TEXT,
  company_name        TEXT,
  bsns_year           TEXT NOT NULL,
  reprt_code          TEXT NOT NULL,
  row_key             TEXT NOT NULL,
  fs_div              TEXT,
  sj_div              TEXT,
  account_id          TEXT NOT NULL,
  account_nm          TEXT NOT NULL,
  account_detail      TEXT,
  thstrm_amount       BIGINT,
  frmtrm_amount       BIGINT,
  bfefrmtrm_amount    BIGINT,
  ordinal             INTEGER,
  raw_data            JSONB DEFAULT '{}'::jsonb,
  source              TEXT DEFAULT 'opendart',
  collected_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (corp_code, bsns_year, reprt_code, row_key)
);

ALTER TABLE investment.corp_financial_reports
  ADD COLUMN IF NOT EXISTS row_key TEXT;

UPDATE investment.corp_financial_reports
   SET row_key = COALESCE(fs_div, '') || '|' ||
                 COALESCE(sj_div, '') || '|' ||
                 COALESCE(account_id, '') || '|' ||
                 COALESCE(account_nm, '') || '|' ||
                 COALESCE(account_detail, '') || '|' ||
                 COALESCE(ordinal::text, '')
 WHERE row_key IS NULL OR row_key = '';

ALTER TABLE investment.corp_financial_reports
  ALTER COLUMN row_key SET DEFAULT '';

ALTER TABLE investment.corp_financial_reports
  ALTER COLUMN row_key SET NOT NULL;

ALTER TABLE investment.corp_financial_reports
  DROP CONSTRAINT IF EXISTS corp_financial_reports_pkey;

ALTER TABLE investment.corp_financial_reports
  ADD CONSTRAINT corp_financial_reports_pkey
  PRIMARY KEY (corp_code, bsns_year, reprt_code, row_key);

CREATE INDEX IF NOT EXISTS idx_corp_financial_reports_stock_period
  ON investment.corp_financial_reports(stock_code, bsns_year DESC, reprt_code);

CREATE INDEX IF NOT EXISTS idx_corp_financial_reports_account
  ON investment.corp_financial_reports(account_nm, bsns_year DESC);
