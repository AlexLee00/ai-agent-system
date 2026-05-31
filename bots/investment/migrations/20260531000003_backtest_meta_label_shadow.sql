ALTER TABLE investment.candidate_backtest_status
  ADD COLUMN IF NOT EXISTS meta_label_dist jsonb,
  ADD COLUMN IF NOT EXISTS meta_label_pos_rate double precision,
  ADD COLUMN IF NOT EXISTS meta_label_n_trades integer,
  ADD COLUMN IF NOT EXISTS meta_label_method text;

