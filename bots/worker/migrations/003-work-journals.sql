-- migrations/003-work-journals.sql — 워커팀 업무일지 테이블

CREATE TABLE IF NOT EXISTS worker.work_journals (
    id          SERIAL PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES worker.companies(id),
    employee_id INTEGER NOT NULL REFERENCES worker.employees(id),
    date        DATE NOT NULL DEFAULT CURRENT_DATE,
    content     TEXT NOT NULL,
    category    TEXT DEFAULT 'general' CHECK (category IN ('general','meeting','task','report','other')),
    attachments JSONB DEFAULT '[]',
    ai_summary  TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_work_journals_company  ON worker.work_journals(company_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_journals_employee ON worker.work_journals(employee_id, date)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_journals_date     ON worker.work_journals(date)               WHERE deleted_at IS NULL;
