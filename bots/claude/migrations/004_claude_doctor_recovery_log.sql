-- Migration: 004_claude_doctor_recovery_log.sql
-- Phase D: Doctor Verify Loop 복구 이력 장기 저장 테이블
-- 기존 reservation.doctor_log와 별도 — Verify Loop 상세 추적용

CREATE TABLE IF NOT EXISTS reservation.claude_doctor_recovery_log (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT        NOT NULL,
  params      JSONB,
  caller_bot  TEXT,
  attempts    INTEGER     NOT NULL DEFAULT 1,
  success     BOOLEAN     NOT NULL,
  verified    BOOLEAN,
  duration_ms INTEGER,
  error_msg   TEXT,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doctor_recovery_action
  ON reservation.claude_doctor_recovery_log (action, inserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_doctor_recovery_success
  ON reservation.claude_doctor_recovery_log (success, inserted_at DESC);

COMMENT ON TABLE reservation.claude_doctor_recovery_log IS
  'Doctor Verify Loop 복구 이력 — 재시도 횟수 + 검증 결과 포함 (Phase D)';
