-- investment.account_balances — 거래소 실제 잔고 스냅샷 테이블
-- balance-sync-15min.ts 가 15분마다 Binance/KIS 잔고를 여기 저장
-- DB pnl vs 실제 잔고 비교 목적
CREATE TABLE IF NOT EXISTS investment.account_balances (
  id               BIGSERIAL PRIMARY KEY,
  exchange         TEXT        NOT NULL,  -- binance / kis / kis_overseas
  account_type     TEXT        NOT NULL,  -- main / paper / sub
  asset            TEXT        NOT NULL,  -- USDT / KRW / USD
  total_balance    NUMERIC(20, 8) NOT NULL,
  available_balance NUMERIC(20, 8) NOT NULL,
  usd_value        NUMERIC(20, 2),        -- USD 환산값 (KRW 자동 환산)
  raw_json         JSONB,                 -- 거래소 원본 응답
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_balances_exchange_captured
  ON investment.account_balances (exchange, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_balances_captured
  ON investment.account_balances (captured_at DESC);

-- 최신 잔고 view (거래소별 최신 스냅샷)
CREATE OR REPLACE VIEW investment.v_latest_account_balances AS
SELECT DISTINCT ON (exchange, account_type, asset)
  id, exchange, account_type, asset,
  total_balance, available_balance, usd_value,
  captured_at
FROM investment.account_balances
ORDER BY exchange, account_type, asset, captured_at DESC;

-- DB 누적 PnL vs 실제 잔고 비교 view
CREATE OR REPLACE VIEW investment.v_trades_vs_balance AS
SELECT
  b.exchange,
  b.asset,
  b.total_balance                                        AS actual_balance,
  b.usd_value                                            AS actual_usd,
  b.captured_at                                          AS balance_at,
  COALESCE(p.total_pnl_usdt, 0)                          AS db_pnl_usdt,
  COALESCE(p.trade_count, 0)                             AS db_trade_count,
  b.usd_value - COALESCE(p.cumulative_usdt, 0)           AS gap_usd
FROM investment.v_latest_account_balances b
LEFT JOIN (
  SELECT
    exchange,
    COUNT(*)                          AS trade_count,
    ROUND(SUM(pnl_usdt)::numeric, 2)  AS total_pnl_usdt,
    ROUND(SUM(pnl_usdt)::numeric, 2)  AS cumulative_usdt
  FROM investment.trades
  WHERE paper = false
    AND pnl_usdt IS NOT NULL
  GROUP BY exchange
) p ON p.exchange = b.exchange;

COMMENT ON TABLE investment.account_balances IS
  '거래소 실제 잔고 스냅샷. balance-sync-15min.ts가 15분마다 갱신';
COMMENT ON VIEW investment.v_trades_vs_balance IS
  'DB 누적 PnL vs 거래소 실제 잔고 비교. gap_usd = 실잔고 - DB PnL 누적';
