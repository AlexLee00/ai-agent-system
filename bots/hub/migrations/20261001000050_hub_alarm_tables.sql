-- hub_alarm_classifications: LLM 분류 결과 영속화
-- Polish 1 — Phase A/B/C 활성화

CREATE TABLE IF NOT EXISTS agent.hub_alarm_classifications (
  id               BIGSERIAL PRIMARY KEY,
  alarm_id         BIGINT NOT NULL,
  classifier_source TEXT NOT NULL,   -- 'rule' | 'llm'
  alarm_type       TEXT NOT NULL,    -- 'work' | 'report' | 'error' | 'critical'
  confidence       NUMERIC(4,3),
  rule_score       NUMERIC(4,3),
  llm_score        NUMERIC(4,3),
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hub_alarm_cls_alarm_id ON agent.hub_alarm_classifications (alarm_id);
CREATE INDEX IF NOT EXISTS idx_hub_alarm_cls_source   ON agent.hub_alarm_classifications (classifier_source, created_at DESC);

-- hub_alarms: 알람 핑거프린트 추적 (Severity Decay용, Polish 5에서 연동)
-- event_lake와 중복되지 않음 — fingerprint_count, decay 전용 필드 포함

CREATE TABLE IF NOT EXISTS agent.hub_alarms (
  id                BIGSERIAL PRIMARY KEY,
  team              TEXT,
  bot_name          TEXT,
  severity          TEXT,
  alarm_type        TEXT,
  title             TEXT,
  message           TEXT,
  fingerprint       TEXT,
  fingerprint_count INT     NOT NULL DEFAULT 1,
  visibility        TEXT,
  actionability     TEXT,
  status            TEXT    NOT NULL DEFAULT 'new',
  metadata          JSONB,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hub_alarms_fingerprint  ON agent.hub_alarms (fingerprint);
CREATE INDEX IF NOT EXISTS idx_hub_alarms_received_at  ON agent.hub_alarms (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_alarms_status       ON agent.hub_alarms (status, alarm_type);
