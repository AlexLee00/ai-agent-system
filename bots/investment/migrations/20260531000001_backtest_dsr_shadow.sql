ALTER TABLE investment.candidate_backtest_status
  ADD COLUMN IF NOT EXISTS dsr DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS psr DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sr0 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sr_oos_unann DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS periods_per_year DOUBLE PRECISION;

COMMENT ON COLUMN investment.candidate_backtest_status.dsr IS
  'Shadow Deflated Sharpe Ratio probability from Bailey/Lopez de Prado FST, not used by gates yet.';
COMMENT ON COLUMN investment.candidate_backtest_status.psr IS
  'Shadow Probabilistic Sharpe Ratio with SR0=0, not used by gates yet.';
COMMENT ON COLUMN investment.candidate_backtest_status.sr0 IS
  'False Strategy Theorem expected max Sharpe threshold in per-period units.';
COMMENT ON COLUMN investment.candidate_backtest_status.sr_oos_unann IS
  'OOS Sharpe converted from annualized vectorbt units to per-period units.';
COMMENT ON COLUMN investment.candidate_backtest_status.periods_per_year IS
  'Annualization factor used to convert Sharpe and var_sharpe to per-period units.';
