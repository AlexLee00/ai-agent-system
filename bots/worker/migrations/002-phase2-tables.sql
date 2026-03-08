-- migrations/002-phase2-tables.sql — 워커팀 Phase 2 테이블
-- 직원, 근태, 매출, 문서

-- ── 직원 테이블 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.employees (
    id          SERIAL PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES worker.companies(id),
    user_id     INTEGER REFERENCES worker.users(id),
    name        TEXT NOT NULL,
    phone       TEXT,
    position    TEXT,
    department  TEXT,
    hire_date   DATE,
    status      TEXT DEFAULT 'active' CHECK (status IN ('active','resigned')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_worker_employees_company ON worker.employees(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_employees_user   ON worker.employees(user_id)    WHERE deleted_at IS NULL;

-- ── 근태 테이블 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.attendance (
    id          SERIAL PRIMARY KEY,
    company_id  TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES worker.employees(id),
    date        DATE NOT NULL DEFAULT CURRENT_DATE,
    check_in    TIMESTAMPTZ,
    check_out   TIMESTAMPTZ,
    status      TEXT DEFAULT 'present' CHECK (status IN ('present','late','absent','leave')),
    note        TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_worker_attendance_company ON worker.attendance(company_id, date);
CREATE INDEX IF NOT EXISTS idx_worker_attendance_emp    ON worker.attendance(employee_id, date);

-- ── 매출 테이블 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.sales (
    id            SERIAL PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES worker.companies(id),
    date          DATE NOT NULL DEFAULT CURRENT_DATE,
    amount        INTEGER NOT NULL,
    category      TEXT,
    description   TEXT,
    registered_by INTEGER REFERENCES worker.users(id),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_worker_sales_company ON worker.sales(company_id, date) WHERE deleted_at IS NULL;

-- ── 문서 테이블 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.documents (
    id          SERIAL PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES worker.companies(id),
    category    TEXT,
    filename    TEXT NOT NULL,
    file_path   TEXT,
    ai_summary  TEXT,
    uploaded_by INTEGER REFERENCES worker.users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_worker_documents_company ON worker.documents(company_id) WHERE deleted_at IS NULL;
