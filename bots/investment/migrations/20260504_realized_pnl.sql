-- Realized PnL columns for trades — CODEX_LUNA_TRADE_DATA_ANALYSIS_REPORT 보강 8
-- 2026-05-04 | BUY-SELL 매칭 후 실 손익 자동 계산 지원

ALTER TABLE investment.trades
  ADD COLUMN IF NOT EXISTS realized_pnl_usdt  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS realized_pnl_pct   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS matched_buy_id     TEXT;

-- SELL 거래 조회 성능 (backfill + dashboard 쿼리)
CREATE INDEX IF NOT EXISTS idx_trades_sell_pnl
  ON investment.trades (exchange, symbol, executed_at DESC)
  WHERE side = 'sell';

-- realized_pnl_pct 기반 성과 정렬
CREATE INDEX IF NOT EXISTS idx_trades_realized_pnl
  ON investment.trades (realized_pnl_pct DESC NULLS LAST)
  WHERE side = 'sell' AND realized_pnl_pct IS NOT NULL;

-- symbol+exchange 기준 BUY/SELL 전체 조회 (FIFO 매칭)
CREATE INDEX IF NOT EXISTS idx_trades_symbol_exchange_side
  ON investment.trades (symbol, exchange, side, executed_at ASC);
