-- v_trades_real_usd 정밀화
-- journal_reconciled_with_fill / journal_reconciled_sell_trade 처럼 실제 PnL이
-- 확인된 reconciliation 거래는 분석 뷰에 포함한다.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS investment.v_trades_real_usd;

CREATE MATERIALIZED VIEW investment.v_trades_real_usd AS
WITH latest_fx AS (
  SELECT DISTINCT ON (base_currency)
    base_currency,
    rate,
    inverse_rate
  FROM investment.fx_rates
  WHERE quote_currency = 'USD'
  ORDER BY base_currency, effective_date DESC
),
krw_rate AS (
  SELECT COALESCE(
    (SELECT rate FROM latest_fx WHERE base_currency = 'KRW'),
    0.000735
  ) AS rate
),
normalized AS (
  SELECT
    j.id,
    j.trade_id,
    j.signal_id,
    j.exchange,
    j.market,
    j.symbol,
    j.direction,
    j.is_paper,
    j.entry_time,
    j.entry_price,
    j.entry_value,
    j.exit_time,
    j.exit_price,
    j.exit_value,
    j.exit_reason,
    j.pnl_amount AS pnl_raw,
    j.status,
    j.market_regime,
    j.strategy_family,
    CASE
      WHEN j.exchange = 'kis' THEN 'KRW'
      WHEN j.exchange = 'kis_overseas' THEN 'USD'
      ELSE 'USDT'
    END AS currency,
    CASE
      WHEN j.exchange = 'kis' THEN j.pnl_amount * (SELECT rate FROM krw_rate)
      ELSE j.pnl_amount
    END AS pnl_usd,
    CASE
      WHEN j.exchange = 'kis' THEN j.entry_value * (SELECT rate FROM krw_rate)
      ELSE j.entry_value
    END AS entry_value_usd
  FROM investment.trade_journal j
  WHERE j.exit_reason IS NOT NULL
    AND COALESCE(j.exit_reason, '') NOT IN (
      'journal_reconciled_no_position',
      'journal_reconciled_duplicate_open'
    )
    AND j.exit_reason NOT LIKE 'sweeper_manual_dust%'
    AND j.exit_reason NOT LIKE 'orphan_cleanup%'
    AND j.pnl_amount IS NOT NULL
)
SELECT * FROM normalized;

CREATE UNIQUE INDEX IF NOT EXISTS idx_v_trades_real_usd_id
  ON investment.v_trades_real_usd (id);

CREATE INDEX IF NOT EXISTS idx_v_trades_real_usd_exchange
  ON investment.v_trades_real_usd (exchange);

CREATE INDEX IF NOT EXISTS idx_v_trades_real_usd_exit_time
  ON investment.v_trades_real_usd (exit_time DESC);

CREATE INDEX IF NOT EXISTS idx_v_trades_real_usd_paper
  ON investment.v_trades_real_usd (is_paper);

CREATE INDEX IF NOT EXISTS idx_v_trades_real_usd_exchange_paper
  ON investment.v_trades_real_usd (exchange, is_paper);

COMMIT;
