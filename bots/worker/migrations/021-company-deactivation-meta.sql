-- 021-company-deactivation-meta.sql — 업체 비활성화 메타데이터

ALTER TABLE worker.companies
  ADD COLUMN IF NOT EXISTS deactivated_reason TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES worker.users(id);
