-- trade_journal: fill resolver 감사 추적 컬럼 추가
-- 목적: 귀속된 거래소 order/trade id와 매칭 방법을 기록하여
--       재 reconciliation 시 중복 귀속 방지 및 감사 가능

BEGIN;

ALTER TABLE investment.trade_journal
  ADD COLUMN IF NOT EXISTS exit_order_ids  TEXT,       -- 귀속된 거래소 order id (콤마 구분)
  ADD COLUMN IF NOT EXISTS exit_fill_ids   TEXT,       -- 귀속된 거래소 trade(fill) id (콤마 구분)
  ADD COLUMN IF NOT EXISTS exit_match_source TEXT;     -- 'order_id' | 'single_fill' | 'unresolved'

COMMENT ON COLUMN investment.trade_journal.exit_order_ids   IS '청산 귀속 거래소 order id 목록 (콤마 구분)';
COMMENT ON COLUMN investment.trade_journal.exit_fill_ids    IS '청산 귀속 거래소 fill(trade) id 목록 (콤마 구분)';
COMMENT ON COLUMN investment.trade_journal.exit_match_source IS 'fill resolver 매칭 방법: order_id | single_fill | unresolved';

COMMIT;
