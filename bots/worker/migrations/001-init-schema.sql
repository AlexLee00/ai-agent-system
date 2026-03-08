-- bots/worker/migrations/001-init-schema.sql
-- worker 스키마 초기 생성
-- 실행: psql -d jay -f bots/worker/migrations/001-init-schema.sql

-- ── 스키마 ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS worker;

-- ── 업체 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- ── 사용자 (로그인 계정) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.users (
  id            SERIAL PRIMARY KEY,
  company_id    TEXT REFERENCES worker.companies(id),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('master','admin','member')),
  name          TEXT NOT NULL,
  email         TEXT,
  telegram_id   BIGINT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

-- ── 감사 추적 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.audit_log (
  id          SERIAL PRIMARY KEY,
  company_id  TEXT NOT NULL,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  target_id   INTEGER,
  detail      JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 승인 요청 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker.approval_requests (
  id            SERIAL PRIMARY KEY,
  company_id    TEXT NOT NULL,
  requester_id  INTEGER NOT NULL,
  approver_id   INTEGER,
  category      TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_table  TEXT NOT NULL,
  target_id     INTEGER,
  payload       JSONB NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  priority      TEXT DEFAULT 'normal'  CHECK (priority IN ('normal','urgent')),
  reject_reason TEXT,
  approved_at   TIMESTAMPTZ,
  rejected_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

-- ── 인덱스 ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_worker_users_company       ON worker.users (company_id);
CREATE INDEX IF NOT EXISTS idx_worker_audit_company_time  ON worker.audit_log (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_approval_company    ON worker.approval_requests (company_id, status);
CREATE INDEX IF NOT EXISTS idx_worker_approval_approver   ON worker.approval_requests (approver_id, status);
