-- Migration: 20260528000004_backtest_oos_columns
-- 목적: candidate_backtest_status에 OOS/deflation 컬럼 추가
-- 근거: CODEX_LUNA_BACKTEST_RELIABILITY_2026-05-28 Phase 2

ALTER TABLE candidate_backtest_status
  ADD COLUMN IF NOT EXISTS sharpe_oos          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sharpe_is           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sharpe_oos_deflated DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS overfit_gap         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS n_grid_trials       INT,
  ADD COLUMN IF NOT EXISTS walk_forward_sharpe DOUBLE PRECISION;

-- 기존 sharpe 컬럼은 호환 유지 (IS sharpe 미러링 — Phase 3 gate가 sharpe_oos_deflated 우선 사용)
COMMENT ON COLUMN candidate_backtest_status.sharpe               IS 'IS avg sharpe (backward-compat, gate uses sharpe_oos_deflated when available)';
COMMENT ON COLUMN candidate_backtest_status.sharpe_is            IS 'In-sample sharpe (grid 최적화 구간)';
COMMENT ON COLUMN candidate_backtest_status.sharpe_oos           IS 'Out-of-sample sharpe (OOS 독립 평가)';
COMMENT ON COLUMN candidate_backtest_status.sharpe_oos_deflated  IS 'OOS sharpe after multi-comparison deflation — 진입 게이트 기본값';
COMMENT ON COLUMN candidate_backtest_status.overfit_gap          IS 'sharpe_is - sharpe_oos (클수록 과적합)';
COMMENT ON COLUMN candidate_backtest_status.n_grid_trials        IS '시도한 파라미터 조합 수 (deflation 계산에 사용)';
COMMENT ON COLUMN candidate_backtest_status.walk_forward_sharpe  IS 'Rolling walk-forward fold 평균 sharpe (향후 Phase 2+)';
