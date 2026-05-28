-- Luna backtest reliability: OOS / deflated Sharpe tracking columns
-- Phase 2: keep legacy sharpe while storing reliability-adjusted metrics.

CREATE SCHEMA IF NOT EXISTS investment;

ALTER TABLE IF EXISTS investment.candidate_backtest_status
  ADD COLUMN IF NOT EXISTS sharpe_oos DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sharpe_is DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sharpe_oos_deflated DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS overfit_gap DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS n_grid_trials INT,
  ADD COLUMN IF NOT EXISTS walk_forward_sharpe DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_cbs_oos_deflated
  ON investment.candidate_backtest_status (sharpe_oos_deflated DESC NULLS LAST, updated_at DESC);

COMMENT ON COLUMN investment.candidate_backtest_status.sharpe_oos IS
  'Out-of-sample Sharpe from IS/OOS or walk-forward evaluation.';
COMMENT ON COLUMN investment.candidate_backtest_status.sharpe_is IS
  'In-sample Sharpe from the selected training window.';
COMMENT ON COLUMN investment.candidate_backtest_status.sharpe_oos_deflated IS
  'OOS Sharpe after multiple-comparison deflation.';
COMMENT ON COLUMN investment.candidate_backtest_status.overfit_gap IS
  'sharpe_is - sharpe_oos; high values indicate likely overfit.';
COMMENT ON COLUMN investment.candidate_backtest_status.n_grid_trials IS
  'Number of grid trials used by the IS optimization path.';
COMMENT ON COLUMN investment.candidate_backtest_status.walk_forward_sharpe IS
  'Mean OOS Sharpe across walk-forward test folds.';
