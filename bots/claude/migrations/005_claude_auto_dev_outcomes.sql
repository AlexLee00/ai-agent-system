-- Migration: 005_claude_auto_dev_outcomes.sql
-- Claude auto-dev 처리 결과를 시그마 vault 학습 소스로 넘기기 위한 원천 테이블.

CREATE SCHEMA IF NOT EXISTS claude;

CREATE TABLE IF NOT EXISTS claude.auto_dev_outcomes (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT,
  rel_path TEXT NOT NULL,
  outcome TEXT NOT NULL,
  stage TEXT,
  content_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  stale_recovery_count INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  test_pass BOOLEAN,
  error_summary TEXT,
  commit_sha TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claude_auto_dev_outcomes_created_at
  ON claude.auto_dev_outcomes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claude_auto_dev_outcomes_outcome
  ON claude.auto_dev_outcomes (outcome);

CREATE INDEX IF NOT EXISTS idx_claude_auto_dev_outcomes_job_id
  ON claude.auto_dev_outcomes (job_id);

COMMENT ON TABLE claude.auto_dev_outcomes IS
  'Claude auto-dev 처리 결과 원천 테이블 — sigma vault 학습 feed source=claude_auto_dev';
