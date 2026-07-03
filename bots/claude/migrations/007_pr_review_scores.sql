-- Migration: 007_pr_review_scores.sql
-- Claude PR quality gate 점수 원장. 실제 적용은 마스터 승인 후 별도 수행한다.

CREATE SCHEMA IF NOT EXISTS claude;

CREATE TABLE IF NOT EXISTS claude.pr_review_scores (
  id BIGSERIAL PRIMARY KEY,
  pr_number INTEGER NOT NULL,
  build_score INTEGER NOT NULL DEFAULT 0,
  review_score INTEGER NOT NULL DEFAULT 0,
  guard_score INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claude_pr_review_scores_pr_created
  ON claude.pr_review_scores (pr_number, created_at DESC);
