-- 005-phase3-tables.sql — Phase 3: 급여/프로젝트/일정/로그 테이블

-- ── 급여 (소피) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.payroll (
  id              SERIAL PRIMARY KEY,
  company_id      TEXT    NOT NULL REFERENCES worker.companies(id),
  employee_id     INTEGER NOT NULL REFERENCES worker.employees(id),
  year_month      TEXT    NOT NULL,           -- '2026-03'
  base_salary     INTEGER DEFAULT 0,          -- 기본급
  overtime_pay    INTEGER DEFAULT 0,          -- 야근수당
  holiday_pay     INTEGER DEFAULT 0,          -- 휴일수당
  incentive       INTEGER DEFAULT 0,          -- 인센티브
  deduction       INTEGER DEFAULT 0,          -- 공제 합계
  deduction_detail JSONB  DEFAULT '{}',       -- {건보, 국민연금, 고용보험, 소득세}
  net_salary      INTEGER DEFAULT 0,          -- 실수령액
  work_days       INTEGER DEFAULT 0,          -- 실근무일
  late_count      INTEGER DEFAULT 0,          -- 지각
  absent_count    INTEGER DEFAULT 0,          -- 결근
  performance     TEXT,                       -- S/A/B/C/D
  status          TEXT    DEFAULT 'draft',    -- draft/confirmed/paid
  confirmed_by    INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, employee_id, year_month)
);

-- ── 프로젝트 (라이언) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.projects (
  id          SERIAL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES worker.companies(id),
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    DEFAULT 'planning', -- planning/in_progress/review/completed
  progress    INTEGER DEFAULT 0,          -- 0~100
  owner_id    INTEGER REFERENCES worker.employees(id),
  start_date  DATE,
  end_date    DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS worker.milestones (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES worker.projects(id),
  company_id   TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT,
  status       TEXT    DEFAULT 'pending', -- pending/in_progress/completed
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  assigned_to  INTEGER REFERENCES worker.employees(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

-- ── 일정 (클로이) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.schedules (
  id          SERIAL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES worker.companies(id),
  title       TEXT    NOT NULL,
  description TEXT,
  type        TEXT    DEFAULT 'task',     -- meeting/task/event/reminder
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ,
  all_day     BOOLEAN DEFAULT FALSE,
  location    TEXT,
  attendees   JSONB   DEFAULT '[]',       -- [employee_id, ...]
  recurrence  TEXT,                       -- null/daily/weekly/monthly
  reminder    INTEGER DEFAULT 30,         -- 분 전 알림
  created_by  INTEGER REFERENCES worker.employees(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- ── 접근 로그 (OWASP) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.access_log (
  id               SERIAL PRIMARY KEY,
  company_id       TEXT,
  user_id          INTEGER,
  username         TEXT,
  action           TEXT NOT NULL,         -- login/logout/login_fail/api_call/forbidden
  method           TEXT,
  url              TEXT,
  status_code      INTEGER,
  ip_address       TEXT,
  user_agent       TEXT,
  response_time_ms INTEGER,
  detail           JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_log_company ON worker.access_log(company_id);
CREATE INDEX IF NOT EXISTS idx_access_log_created ON worker.access_log(created_at);
CREATE INDEX IF NOT EXISTS idx_access_log_action  ON worker.access_log(action);

-- ── 에러 로그 ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.error_log (
  id          SERIAL PRIMARY KEY,
  company_id  TEXT,
  user_id     INTEGER,
  level       TEXT DEFAULT 'error',       -- error/warn/fatal
  message     TEXT NOT NULL,
  stack_trace TEXT,
  url         TEXT,
  method      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
