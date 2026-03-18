CREATE TABLE IF NOT EXISTS worker.system_preferences (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by INTEGER REFERENCES worker.users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE worker.system_preferences IS
  '워커 웹 운영 선택값과 시스템 선호도를 저장하는 소규모 설정 테이블';
