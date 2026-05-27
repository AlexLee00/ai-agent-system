-- Luna Learning Progress View
-- 마스터 철학: "끊임없는 분석 → 피드백 → 진화" 모니터링
-- 생성: 2026-05-27

CREATE OR REPLACE VIEW investment.v_luna_learning_progress AS
WITH daily_signals AS (
  SELECT
    DATE(created_at)                    AS trade_date,
    market,
    trade_mode,
    COUNT(*)                            AS signal_count,
    COUNT(*) FILTER (WHERE event_type = 'trade_failed') AS failed_count,
    AVG(confidence)                     AS avg_confidence
  FROM investment.position_signal_history
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY DATE(created_at), market, trade_mode
),
daily_quality AS (
  SELECT
    DATE(tqe.created_at)                AS eval_date,
    AVG(tqe.overall_score)              AS avg_quality_score,
    COUNT(*)                            AS eval_count,
    COUNT(*) FILTER (WHERE tqe.category = 'excellent') AS excellent_count
  FROM investment.trade_quality_evaluations tqe
  WHERE tqe.created_at >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY DATE(tqe.created_at)
),
daily_mutations AS (
  SELECT
    DATE(created_at)                    AS mutation_date,
    COUNT(*)                            AS mutation_count
  FROM investment.strategy_mutation_events
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY DATE(created_at)
),
analyst_levels AS (
  SELECT
    market,
    COUNT(*) FILTER (WHERE current_level = 'expert')       AS expert_count,
    COUNT(*) FILTER (WHERE current_level = 'intermediate') AS intermediate_count,
    COUNT(*) FILTER (WHERE current_level = 'novice')       AS novice_count
  FROM investment.agent_curriculum_state
  GROUP BY market
),
failure_reflexions AS (
  SELECT
    DATE(created_at)                    AS reflexion_date,
    COUNT(*)                            AS reflexion_count
  FROM investment.luna_failure_reflexions
  WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY DATE(created_at)
)
SELECT
  ds.trade_date,
  ds.market,
  ds.trade_mode,
  ds.signal_count,
  ds.failed_count,
  ROUND(ds.avg_confidence::numeric, 3)  AS avg_confidence,
  COALESCE(dq.avg_quality_score, 0)     AS avg_quality_score,
  COALESCE(dq.eval_count, 0)            AS eval_count,
  COALESCE(dq.excellent_count, 0)       AS excellent_count,
  COALESCE(dm.mutation_count, 0)        AS mutation_count,
  COALESCE(fr.reflexion_count, 0)       AS reflexion_count,
  al.expert_count,
  al.intermediate_count,
  al.novice_count,
  -- 학습 진행률 (0~1)
  ROUND(
    LEAST(1.0,
      (COALESCE(dq.avg_quality_score, 0) * 0.4 +
       LEAST(1.0, ds.signal_count / 20.0) * 0.3 +
       LEAST(1.0, COALESCE(al.expert_count, 0) / 5.0) * 0.3)
    )::numeric, 3
  )                                     AS learning_progress
FROM daily_signals ds
LEFT JOIN daily_quality  dq ON dq.eval_date    = ds.trade_date
LEFT JOIN daily_mutations dm ON dm.mutation_date = ds.trade_date
LEFT JOIN analyst_levels  al ON al.market       = ds.market
LEFT JOIN failure_reflexions fr ON fr.reflexion_date = ds.trade_date
ORDER BY ds.trade_date DESC, ds.market;

COMMENT ON VIEW investment.v_luna_learning_progress IS
  '루나 학습 진행 현황 — 일별 신호/품질/변이/커리큘럼/반성 통합 뷰';
