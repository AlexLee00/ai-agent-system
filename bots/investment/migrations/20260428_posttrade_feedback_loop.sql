-- ─── Posttrade Feedback Loop — Phase A/B/C ────────────────────────────────────
-- 2026-04-28 | CODEX_LUNA_INTELLIGENT_POSTTRADE_FEEDBACK_LOOP_PLAN

-- Phase A: Trade Quality Score (4-차원 평가)
CREATE TABLE IF NOT EXISTS investment.trade_quality_evaluations (
  trade_id                   BIGINT PRIMARY KEY,
  market_decision_score      NUMERIC(4,3),   -- 1. 매매 적절성
  pipeline_quality_score     NUMERIC(4,3),   -- 2. 자료/평가/매수/매도 전 단계
  monitoring_score           NUMERIC(4,3),   -- 3. 포지션 관리 충실도
  backtest_utilization_score NUMERIC(4,3),   -- 4. 백테스팅 활용도
  overall_score              NUMERIC(4,3),   -- weighted_sum
  category                   TEXT,           -- preferred | neutral | rejected
  rationale                  TEXT,
  sub_score_breakdown        JSONB DEFAULT '{}',
  evaluated_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tqe_category_score
  ON investment.trade_quality_evaluations (category, overall_score DESC);
CREATE INDEX IF NOT EXISTS idx_tqe_evaluated_at
  ON investment.trade_quality_evaluations (evaluated_at DESC);

-- Phase B: Stage Attribution Tracker
CREATE TABLE IF NOT EXISTS investment.trade_decision_attribution (
  trade_id             BIGINT     NOT NULL,
  stage_id             TEXT       NOT NULL,  -- discovery|sentiment|technical|setup|entry|stage_1..8|exit
  decision_type        TEXT,
  decision_score       NUMERIC(4,3),
  contribution_to_outcome NUMERIC(5,4),     -- -1 ~ +1
  evidence             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trade_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_tda_trade_id
  ON investment.trade_decision_attribution (trade_id);
CREATE INDEX IF NOT EXISTS idx_tda_stage_contribution
  ON investment.trade_decision_attribution (stage_id, contribution_to_outcome DESC);

-- Phase C: Failure Reflexions (Reflexion + Chain-of-Hindsight)
CREATE TABLE IF NOT EXISTS investment.luna_failure_reflexions (
  id              BIGSERIAL   PRIMARY KEY,
  trade_id        BIGINT      NOT NULL,
  five_why        JSONB       DEFAULT '[]',  -- [{q, a}, ...]
  stage_attribution JSONB     DEFAULT '{}',
  hindsight       TEXT,                      -- "X 대신 Y를 했어야 했다"
  avoid_pattern   JSONB       DEFAULT '{}',  -- {symbol_pattern, avoid_action, reason, evidence}
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lfr_trade_id
  ON investment.luna_failure_reflexions (trade_id);
CREATE INDEX IF NOT EXISTS idx_lfr_avoid_pattern
  ON investment.luna_failure_reflexions USING GIN (avoid_pattern);
CREATE INDEX IF NOT EXISTS idx_lfr_created_at
  ON investment.luna_failure_reflexions (created_at DESC);
