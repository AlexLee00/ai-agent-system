-- 006-companies-extra.sql — worker.companies 업체 추가 정보 컬럼
-- owner: 대표자
-- phone: 연락처
-- biz_number: 사업자등록번호
-- memo: 메모

ALTER TABLE worker.companies
  ADD COLUMN IF NOT EXISTS owner      TEXT,
  ADD COLUMN IF NOT EXISTS phone      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS biz_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS memo       TEXT;
