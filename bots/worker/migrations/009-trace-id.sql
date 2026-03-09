-- 009-trace-id.sql — 통합 trace_id + tool_calls 테이블
-- 에이전트 오케스트레이션 Phase 2

-- 1. agent_events에 trace_id 추가
ALTER TABLE reservation.agent_events
ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;

-- 2. agent_tasks에 trace_id 추가
ALTER TABLE reservation.agent_tasks
ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;

-- 3. audit_log에 trace_id 추가 (worker 스키마)
ALTER TABLE worker.audit_log
ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;

-- 4. tool_calls 테이블 생성
CREATE TABLE IF NOT EXISTS reservation.tool_calls (
  id            BIGSERIAL PRIMARY KEY,
  trace_id      UUID DEFAULT NULL,
  bot           TEXT NOT NULL DEFAULT 'unknown',
  tool_name     TEXT NOT NULL,
  action        TEXT NOT NULL,
  success       BOOLEAN NOT NULL DEFAULT true,
  duration_ms   INTEGER DEFAULT 0,
  error         TEXT DEFAULT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_agent_events_trace_id
ON reservation.agent_events (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace_id
ON reservation.agent_tasks (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_trace_id
ON worker.audit_log (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tool_calls_trace_id
ON reservation.tool_calls (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tool_calls_bot_tool
ON reservation.tool_calls (bot, tool_name, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at
ON reservation.tool_calls (created_at DESC);

-- 코멘트
COMMENT ON COLUMN reservation.agent_events.trace_id IS
'통합 추적 ID — 하나의 요청이 여러 봇을 거칠 때 같은 ID로 연결';

COMMENT ON COLUMN reservation.agent_tasks.trace_id IS
'통합 추적 ID — 태스크 생성 시점의 trace 컨텍스트';

COMMENT ON COLUMN worker.audit_log.trace_id IS
'통합 추적 ID — HTTP 요청과 연결된 추적 ID';

COMMENT ON TABLE reservation.tool_calls IS
'외부 도구/API 호출 로그 — 봇이 Binance, Telegram, PostgreSQL, OpenAI 등을 호출한 기록';
