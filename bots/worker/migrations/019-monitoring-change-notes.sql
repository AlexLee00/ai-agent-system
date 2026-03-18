ALTER TABLE worker.system_preference_events
    ADD COLUMN IF NOT EXISTS change_note TEXT;

COMMENT ON COLUMN worker.system_preference_events.change_note IS
  '워커 기본 LLM API 변경 사유 메모';
