-- investment.v_trades_real_usd — USD 정규화 Materialized View
-- CODEX_LUNA_TRADES_USD_NORMALIZATION Task B
-- 2026-05-12
--
-- 핵심 로직:
--   - trade_journal 기반 (pnl_amount 채워짐 비율이 더 높음)
--   - journal_reconciled / sweeper_manual_dust / orphan_cleanup 자동 제외
--   - KIS → KRW, Binance/Upbit → USDT, KIS Overseas → USD
--   - latest_fx CTE로 최신 환율 자동 반영 (fx_rates 미갱신 시 fallback)

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
    j.pnl_amount                          AS pnl_raw,
    j.status,
    j.market_regime,
    j.strategy_family,
    -- 통화 추론
    CASE
      WHEN j.exchange = 'kis'          THEN 'KRW'
      WHEN j.exchange = 'kis_overseas' THEN 'USD'
      ELSE                                  'USDT'
    END AS currency,
    -- USD 환산 PnL
    CASE
      WHEN j.exchange = 'kis'
        THEN j.pnl_amount * (SELECT rate FROM krw_rate)
      ELSE
        j.pnl_amount
    END AS pnl_usd,
    -- USD 환산 진입 금액
    CASE
      WHEN j.exchange = 'kis'
        THEN j.entry_value * (SELECT rate FROM krw_rate)
      ELSE
        j.entry_value
    END AS entry_value_usd
  FROM investment.trade_journal j
  WHERE
    j.exit_reason IS NOT NULL
    AND j.exit_reason NOT LIKE 'journal_reconciled%'
    AND j.exit_reason NOT LIKE 'sweeper_manual_dust%'
    AND j.exit_reason NOT LIKE 'orphan_cleanup%'
    AND j.pnl_amount IS NOT NULL
)
SELECT * FROM normalized;

-- 인덱스
CREATE UNIQUE INDEX idx_v_trades_real_usd_id
  ON investment.v_trades_real_usd (id);

CREATE INDEX idx_v_trades_real_usd_exchange
  ON investment.v_trades_real_usd (exchange);

CREATE INDEX idx_v_trades_real_usd_exit_time
  ON investment.v_trades_real_usd (exit_time DESC);

CREATE INDEX idx_v_trades_real_usd_paper
  ON investment.v_trades_real_usd (is_paper);

CREATE INDEX idx_v_trades_real_usd_exchange_paper
  ON investment.v_trades_real_usd (exchange, is_paper);
