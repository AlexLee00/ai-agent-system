CREATE TABLE IF NOT EXISTS worker.system_preference_events (
    id             BIGSERIAL PRIMARY KEY,
    preference_key TEXT NOT NULL,
    previous_value JSONB,
    next_value     JSONB NOT NULL DEFAULT '{}'::jsonb,
    changed_by     INTEGER REFERENCES worker.users(id),
    changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_system_preference_events_key_changed_at
    ON worker.system_preference_events (preference_key, changed_at DESC);

COMMENT ON TABLE worker.system_preference_events IS
  '워커 시스템 선호도 변경 이력을 저장하는 감사 이벤트 테이블';
