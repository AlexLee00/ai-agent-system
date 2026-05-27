-- Phase 3: 루나 가드 이벤트 누적 테이블
-- 가드 트리거 → 데이터 수집 + 효과 측정 + 자율 조정 기반

CREATE TABLE IF NOT EXISTS investment.guard_events (
  id              BIGSERIAL PRIMARY KEY,
  guard_name      TEXT NOT NULL,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol          TEXT,
  market          TEXT,
  exchange        TEXT,
  reason          TEXT NOT NULL,
  severity        TEXT DEFAULT 'warning'
                    CHECK (severity IN ('info', 'warning', 'danger')),
  decision_before JSONB,
  decision_after  JSONB,
  trade_id        TEXT,
  outcome         TEXT,
  outcome_pnl_usd NUMERIC(20,4),
  guard_metadata  JSONB
);

CREATE INDEX IF NOT EXISTS idx_guard_events_guard_time
  ON investment.guard_events (guard_name, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_guard_events_severity_time
  ON investment.guard_events (severity, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_guard_events_symbol_time
  ON investment.guard_events (symbol, triggered_at DESC);

-- 가드 효과 측정 뷰: 가드별 트리거 횟수 + 결과 분석
CREATE OR REPLACE VIEW investment.v_guard_effectiveness AS
SELECT
  guard_name,
  COUNT(*)                                           AS total_triggers,
  COUNT(*) FILTER (WHERE outcome = 'success')        AS success_count,
  COUNT(*) FILTER (WHERE outcome = 'failure')        AS failure_count,
  COUNT(*) FILTER (WHERE outcome IS NULL)            AS pending_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE outcome = 'success')
    / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0),
    2
  )                                                  AS success_rate_pct,
  AVG(outcome_pnl_usd)
    FILTER (WHERE outcome_pnl_usd IS NOT NULL)       AS avg_outcome_pnl_usd,
  SUM(outcome_pnl_usd)
    FILTER (WHERE outcome_pnl_usd IS NOT NULL)       AS total_outcome_pnl_usd,
  MAX(triggered_at)                                  AS last_triggered_at,
  MIN(triggered_at)                                  AS first_triggered_at
FROM investment.guard_events
GROUP BY guard_name;
