-- 007-employees-base-salary.sql — worker.employees 기본급 컬럼 추가

ALTER TABLE worker.employees
  ADD COLUMN IF NOT EXISTS base_salary INTEGER DEFAULT 0;
