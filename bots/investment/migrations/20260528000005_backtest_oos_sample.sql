ALTER TABLE investment.candidate_backtest_status
  ADD COLUMN IF NOT EXISTS n_obs_oos INTEGER,
  ADD COLUMN IF NOT EXISTS total_trades_oos INTEGER,
  ADD COLUMN IF NOT EXISTS oos_status TEXT;
