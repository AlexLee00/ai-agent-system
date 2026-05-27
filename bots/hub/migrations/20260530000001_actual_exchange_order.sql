-- investment.trades — actual_exchange_order 컬럼 추가
-- 거래소에 실제 TP/SL 주문이 발생한 매매만 true로 표시
-- paper=false라도 tp_order_id/sl_order_id가 NULL이면 거래소 주문 없음 (페이퍼/검증)
ALTER TABLE investment.trades
  ADD COLUMN IF NOT EXISTS actual_exchange_order BOOLEAN NOT NULL DEFAULT false;

-- 기존 데이터 백필: TP 또는 SL 주문 ID 있으면 실거래소 주문으로 표시
UPDATE investment.trades
SET actual_exchange_order = true
WHERE (tp_order_id IS NOT NULL OR sl_order_id IS NOT NULL)
  AND actual_exchange_order = false;

CREATE INDEX IF NOT EXISTS idx_trades_actual_exchange_order
  ON investment.trades (actual_exchange_order, exchange, created_at DESC);

-- 진짜 실매매만 집계하는 view
-- 조건: actual_exchange_order=true + paper=false + trade_mode='normal'
CREATE OR REPLACE VIEW investment.v_actual_exchange_trades AS
SELECT
  t.id,
  t.exchange,
  t.symbol,
  t.side,
  t.amount,
  t.entry_price,
  t.exit_price,
  t.pnl_usdt,
  t.pnl_krw,
  t.trade_mode,
  t.tp_order_id,
  t.sl_order_id,
  t.tp_sl_set,
  t.created_at,
  t.closed_at,
  CASE WHEN t.pnl_usdt > 0 THEN 'win' ELSE 'loss' END AS result
FROM investment.trades t
WHERE t.actual_exchange_order = true
  AND t.paper = false
  AND t.trade_mode = 'normal';

COMMENT ON VIEW investment.v_actual_exchange_trades IS
  '진짜 거래소 실매매만 조회. actual_exchange_order=true + paper=false + trade_mode=normal 필터 적용';
