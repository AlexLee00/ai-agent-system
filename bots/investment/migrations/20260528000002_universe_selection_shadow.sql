-- universe_selection_shadow — 동적 유니버스 선택 이력
-- Phase 2: 3축(거래량/시총/섹터) × 체제별 동적 유니버스 선택 기록
-- 매일 08:30 갱신 (ai.luna.universe-refresh-daily-0830.plist)
-- 생성: 2026-05-28

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.universe_selection_shadow (
  id               BIGSERIAL PRIMARY KEY,
  selected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  regime           TEXT NOT NULL DEFAULT 'RANGING',  -- TRENDING_BULL / TRENDING_BEAR / RANGING / VOLATILE
  exchange         TEXT NOT NULL DEFAULT 'binance',  -- binance / kis / kis_overseas
  axis_weights     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {volume, cap, sector}
  selected_symbols JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{symbol, score}]
  universe_size    INT NOT NULL DEFAULT 0,
  shadow_only      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_universe_selection_shadow_time
  ON investment.universe_selection_shadow (selected_at DESC);

CREATE INDEX IF NOT EXISTS idx_universe_selection_shadow_regime
  ON investment.universe_selection_shadow (regime, exchange, selected_at DESC);

COMMENT ON TABLE investment.universe_selection_shadow IS
  '3축(거래량/시총/섹터) × 체제별 동적 유니버스 선택 이력 — 매일 08:30 자동 기록';
