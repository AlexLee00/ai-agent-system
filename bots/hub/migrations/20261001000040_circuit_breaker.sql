-- hub.circuit_events — Circuit Breaker 상태 전환 이력 + 실패 기록
-- Phase 1: LLM Routing Hardening

CREATE TABLE IF NOT EXISTS hub.circuit_events (
  id             BIGSERIAL PRIMARY KEY,
  provider       TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,  -- 'opened' | 'closed' | 'half_opened' | 'failed' | 'succeeded'
  reason         TEXT,                  -- 'timeout' | 'empty_response' | 'network' | 'http_4xx' | 'http_5xx'
  latency_ms     INTEGER,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_circuit_provider_time ON hub.circuit_events (provider, inserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_circuit_event_type    ON hub.circuit_events (event_type, inserted_at DESC);

-- Provider 건강도 시계열 뷰 (시간별 집계)
CREATE MATERIALIZED VIEW IF NOT EXISTS hub.provider_health_hourly AS
SELECT
  DATE_TRUNC('hour', inserted_at)                                                    AS hour,
  provider,
  COUNT(*) FILTER (WHERE event_type = 'succeeded')                                   AS success_count,
  COUNT(*) FILTER (WHERE event_type = 'failed')                                      AS failure_count,
  COUNT(*) FILTER (WHERE event_type = 'opened')                                      AS open_count,
  ROUND(AVG(latency_ms) FILTER (WHERE event_type = 'succeeded'))::INTEGER            AS avg_latency_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)
    FILTER (WHERE event_type = 'succeeded')                                           AS p99_latency_ms
FROM hub.circuit_events
WHERE inserted_at > NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', inserted_at), provider;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_health_hour
  ON hub.provider_health_hourly (hour, provider);

-- hub.load_test_results — 부하 테스트 결과 저장
CREATE TABLE IF NOT EXISTS hub.load_test_results (
  id              BIGSERIAL PRIMARY KEY,
  scenario        TEXT        NOT NULL,  -- 'baseline' | 'peak' | 'chaos' | 'multi-team'
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_requests  INTEGER,
  failed_requests INTEGER,
  fail_rate       NUMERIC(6,4),
  p95_latency_ms  INTEGER,
  p99_latency_ms  INTEGER,
  avg_latency_ms  INTEGER,
  duration_s      INTEGER,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_load_test_run ON hub.load_test_results (run_at DESC);
