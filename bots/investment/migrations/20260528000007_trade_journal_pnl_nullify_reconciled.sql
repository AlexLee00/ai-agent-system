-- trade_journal pnl 정합성: reconciliation/dust 가짜 0 PnL을 NULL로 마킹
-- 목적: "측정 안 됨"을 "손익 0"으로 학습하지 않도록 차단

BEGIN;

DO $$
DECLARE
  reconciled_count INT;
  dust_count INT;
BEGIN
  SELECT count(*) INTO reconciled_count
    FROM investment.trade_journal
   WHERE exit_reason LIKE 'journal_reconciled%'
     AND pnl_amount = 0
     AND entry_price = exit_price;

  SELECT count(*) INTO dust_count
    FROM investment.trade_journal
   WHERE exit_reason LIKE 'sweeper_manual_dust%'
     AND pnl_amount = 0
     AND entry_price = exit_price;

  RAISE NOTICE 'trade_journal pnl NULL backfill 대상: journal_reconciled=% sweeper_manual_dust=%',
    reconciled_count, dust_count;
END $$;

UPDATE investment.trade_journal
   SET pnl_amount  = NULL,
       pnl_percent = NULL,
       pnl_net     = NULL
 WHERE exit_reason LIKE 'journal_reconciled%'
   AND pnl_amount = 0
   AND entry_price = exit_price;

UPDATE investment.trade_journal
   SET pnl_amount  = NULL,
       pnl_percent = NULL,
       pnl_net     = NULL
 WHERE exit_reason LIKE 'sweeper_manual_dust%'
   AND pnl_amount = 0
   AND entry_price = exit_price;

COMMIT;
