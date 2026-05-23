-- Stage D2: secrets 만료 모니터링 감사 로그
-- hub.secrets_rotation_log — 만료 스캔 이력 추적. 실제 secret 값 갱신은 별도 승인된 rotator만 수행한다.

CREATE SCHEMA IF NOT EXISTS hub;

CREATE TABLE IF NOT EXISTS hub.secrets_rotation_log (
  id            BIGSERIAL      PRIMARY KEY,
  checked_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  secret_path   TEXT           NOT NULL,
  expires_at    TIMESTAMPTZ,
  days_remaining NUMERIC(8, 1),
  level         TEXT           NOT NULL CHECK (level IN ('healthy', 'warn', 'critical', 'expired')),
  action_taken  TEXT           NOT NULL DEFAULT 'alerted'
                                CHECK (action_taken IN ('alerted', 'rotated', 'rotation_failed', 'skipped')),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_secrets_rotation_log_checked_at
  ON hub.secrets_rotation_log (checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_secrets_rotation_log_level
  ON hub.secrets_rotation_log (level, checked_at DESC);

COMMENT ON TABLE hub.secrets_rotation_log IS 'Stage D2: secrets 만료 스캔 감사 로그. secret 값 자동 변경 없음';
