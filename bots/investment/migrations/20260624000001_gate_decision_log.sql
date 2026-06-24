-- gate_decision_log — 진입 게이트 결정 로깅 (미래 인과검증 인프라)
-- 진입 평가 시점에 게이트 판정 + 핵심 지표 스냅샷 + 실제 진입 여부를 기록
-- 목적: PSR 게이트가 통과/차단한 종목의 실제 손익(v_trades_real_usd)과 N주 후 조인 → 문턱 최적성 실증
-- 선행: DSR→PSR 게이트 전환 (2026-06-24)
-- 생성: 2026-06-24

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.gate_decision_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  evaluated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exchange      TEXT NOT NULL,
  market        TEXT NOT NULL DEFAULT 'crypto',
  symbol        TEXT NOT NULL,
  -- 백테스트 게이트 판정. 실제 발사 여부는 actually_fired로 별도 기록한다.
  gate_passed   BOOLEAN NOT NULL,              -- PSR/DSR/Sharpe 등 backtest gate 통과 여부
  gate_status   TEXT,                          -- candidate_backtest_status.gate_status 스냅샷
  block_reasons JSONB DEFAULT '[]'::jsonb,     -- 차단 사유 배열
  -- 핵심 지표 스냅샷 (미래 변별력 재분석용)
  dsr                 DOUBLE PRECISION,
  psr                 DOUBLE PRECISION,
  sharpe              DOUBLE PRECISION,
  sharpe_oos          DOUBLE PRECISION,
  win_rate            DOUBLE PRECISION,
  max_drawdown        DOUBLE PRECISION,
  walk_forward_sharpe DOUBLE PRECISION,
  -- 진입 경로/실제 행동
  decision_mode  TEXT,                         -- hard_gate / notify 등
  actually_fired BOOLEAN DEFAULT FALSE,        -- 실제 진입(fire) 여부
  confidence     DOUBLE PRECISION,             -- 진입 신호 confidence
  -- 추적용
  signal_id    TEXT,
  trigger_type TEXT,
  shadow_flags JSONB DEFAULT '{}'::jsonb       -- psrGate/dsrGate 등 shadow 판정 메타
);

CREATE INDEX IF NOT EXISTS idx_gate_decision_symbol_time
  ON investment.gate_decision_log (symbol, exchange, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gate_decision_time
  ON investment.gate_decision_log (evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gate_decision_passed
  ON investment.gate_decision_log (gate_passed, evaluated_at DESC);

COMMENT ON TABLE investment.gate_decision_log IS
  '진입 게이트 결정 로깅 — 게이트 판정↔실제손익 인과검증용. 진입 평가 시점마다 비차단(fire-and-forget) 기록';
