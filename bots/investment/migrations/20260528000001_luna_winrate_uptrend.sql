-- Luna 수익 확률 우상향 추적 스키마
-- 마스터 비전: "이길 확률을 계속 높이겠다!"
-- 생성: 2026-05-28

CREATE SCHEMA IF NOT EXISTS investment;

-- ─── 체제별 가중치 스냅샷 테이블 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investment.luna_regime_weight_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  regime         TEXT NOT NULL,                -- TRENDING_BULL / TRENDING_BEAR / RANGING / VOLATILE
  fusion_weights JSONB NOT NULL DEFAULT '{}'::jsonb,  -- ta/fundamental/sentiment/worldquant
  signal_weights JSONB NOT NULL DEFAULT '{}'::jsonb,  -- momentum/breakout/mean_reversion/defensive
  universe_weights JSONB NOT NULL DEFAULT '{}'::jsonb, -- volume/cap/sector
  win_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
  profit_factor  DOUBLE PRECISION NOT NULL DEFAULT 0,
  performance_metric DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_trades   INT NOT NULL DEFAULT 0,
  learn_rate     DOUBLE PRECISION NOT NULL DEFAULT 0.08,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investment.luna_regime_weight_snapshots
  ADD COLUMN IF NOT EXISTS universe_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS performance_metric DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_luna_regime_weight_snapshots_regime_time
  ON investment.luna_regime_weight_snapshots (regime, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_regime_weight_snapshots_time
  ON investment.luna_regime_weight_snapshots (created_at DESC);

-- ─── 일별 수익 확률 집계 뷰 ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW investment.v_winrate_uptrend AS
WITH daily_trades AS (
  SELECT
    DATE(to_timestamp(tj.exit_time / 1000.0))  AS trade_date,
    COALESCE(tj.market, 'crypto')              AS market,
    COALESCE(tj.regime, 'RANGING')             AS regime,
    COUNT(*)                                   AS total_trades,
    COUNT(*) FILTER (WHERE COALESCE(tj.pnl, 0) > 0) AS win_trades,
    SUM(CASE WHEN COALESCE(tj.pnl, 0) > 0 THEN COALESCE(tj.pnl, 0) ELSE 0 END)      AS gross_profit,
    SUM(CASE WHEN COALESCE(tj.pnl, 0) < 0 THEN ABS(COALESCE(tj.pnl, 0)) ELSE 0 END) AS gross_loss,
    AVG(COALESCE(tj.pnl_pct, 0))               AS avg_pnl_pct
  FROM investment.trade_journal tj
  WHERE tj.exit_time IS NOT NULL
    AND NOT COALESCE(tj.is_paper, false)
    AND to_timestamp(tj.exit_time / 1000.0) >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY DATE(to_timestamp(tj.exit_time / 1000.0)), COALESCE(tj.market, 'crypto'), COALESCE(tj.regime, 'RANGING')
),
daily_stats AS (
  SELECT
    trade_date,
    market,
    regime,
    total_trades,
    win_trades,
    gross_profit,
    gross_loss,
    avg_pnl_pct,
    -- 승률 (win rate)
    CASE WHEN total_trades > 0
      THEN ROUND((win_trades::NUMERIC / total_trades), 4)
      ELSE 0
    END AS win_rate,
    -- 손익비 (profit factor)
    CASE WHEN gross_loss > 0
      THEN ROUND((gross_profit / gross_loss)::NUMERIC, 4)
      WHEN gross_profit > 0 THEN 2.0
      ELSE 0
    END AS profit_factor,
    -- 수익 확률 (승률 × 손익비 / (1 + 손익비))
    CASE
      WHEN total_trades > 0 AND gross_loss > 0 THEN
        ROUND(
          (win_trades::NUMERIC / total_trades) *
          (gross_profit / gross_loss) /
          (1 + gross_profit / gross_loss)
        , 4)
      ELSE 0
    END AS profit_probability
  FROM daily_trades
),
moving_avg AS (
  SELECT
    ds.*,
    -- 7일 이동평균 승률
    ROUND(AVG(ds.win_rate) OVER (
      PARTITION BY ds.market
      ORDER BY ds.trade_date
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    )::NUMERIC, 4) AS win_rate_ma7,
    -- 30일 이동평균 승률
    ROUND(AVG(ds.win_rate) OVER (
      PARTITION BY ds.market
      ORDER BY ds.trade_date
      ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    )::NUMERIC, 4) AS win_rate_ma30,
    -- 7일 이동평균 profit_factor
    ROUND(AVG(ds.profit_factor) OVER (
      PARTITION BY ds.market
      ORDER BY ds.trade_date
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    )::NUMERIC, 4) AS profit_factor_ma7,
    -- 7일 누적 거래 수
    SUM(ds.total_trades) OVER (
      PARTITION BY ds.market
      ORDER BY ds.trade_date
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS trades_last7d
  FROM daily_stats ds
)
SELECT
  ma.trade_date,
  ma.market,
  ma.regime,
  ma.total_trades,
  ma.win_trades,
  ma.win_rate,
  ma.profit_factor,
  ma.profit_probability,
  ma.avg_pnl_pct,
  ma.win_rate_ma7,
  ma.win_rate_ma30,
  ma.profit_factor_ma7,
  ma.trades_last7d,
  -- 우상향 여부 (7일 MA > 30일 MA)
  CASE WHEN ma.win_rate_ma7 > ma.win_rate_ma30 THEN true ELSE false END AS is_uptrend,
  -- 최근 7일 기울기 (선형 회귀 근사: 최신 MA7 - 7일전 MA7)
  ROUND((ma.win_rate_ma7 - LAG(ma.win_rate_ma7, 7, ma.win_rate_ma7) OVER (
    PARTITION BY ma.market ORDER BY ma.trade_date
  ))::NUMERIC, 6) AS trend_slope_7d
FROM moving_avg ma
ORDER BY ma.trade_date DESC, ma.market;

COMMENT ON VIEW investment.v_winrate_uptrend IS
  '루나 수익 확률 우상향 추적 — 일별 승률/손익비/이동평균/추세 기울기';

COMMENT ON TABLE investment.luna_regime_weight_snapshots IS
  '체제별 fusion+signal 가중치 학습 이력 — 매일 07:00 자동 기록';
