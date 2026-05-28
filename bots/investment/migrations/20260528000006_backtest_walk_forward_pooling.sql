ALTER TABLE investment.candidate_backtest_status
  ADD COLUMN IF NOT EXISTS selection_method TEXT,
  ADD COLUMN IF NOT EXISTS fold_count INTEGER;
