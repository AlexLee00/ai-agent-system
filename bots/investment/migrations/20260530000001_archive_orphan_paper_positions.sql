-- Phase 2: orphan paper positions archive
-- Safety: run only after confirming live(paper=false) positions are zero.
-- Context: legacy paper positions remained after paper -> live transition. Live
-- position-sync reads paper=false only, so these rows are historical residue.

BEGIN;

DO $$
DECLARE
  live_count integer;
BEGIN
  SELECT COUNT(*) INTO live_count
  FROM investment.positions
  WHERE COALESCE(paper, false) = false;

  IF live_count <> 0 THEN
    RAISE EXCEPTION 'Abort orphan paper archive: live positions exist (%)', live_count;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS investment.positions_archive (LIKE investment.positions INCLUDING ALL);
ALTER TABLE investment.positions_archive ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NOW();
ALTER TABLE investment.positions_archive ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE TABLE IF NOT EXISTS investment.position_strategy_profiles_archive (
  LIKE investment.position_strategy_profiles INCLUDING ALL
);
ALTER TABLE investment.position_strategy_profiles_archive ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NOW();
ALTER TABLE investment.position_strategy_profiles_archive ADD COLUMN IF NOT EXISTS archive_reason text;

-- Archive profiles linked by symbol/exchange before deleting the source positions.
INSERT INTO investment.position_strategy_profiles_archive (
  id,
  symbol,
  exchange,
  signal_id,
  trade_mode,
  status,
  strategy_name,
  strategy_quality_score,
  setup_type,
  thesis,
  monitoring_plan,
  exit_plan,
  backtest_plan,
  market_context,
  strategy_context,
  created_at,
  updated_at,
  closed_at,
  strategy_state,
  last_evaluation_at,
  last_attention_at,
  archived_at,
  archive_reason
)
SELECT
  psp.id,
  psp.symbol,
  psp.exchange,
  psp.signal_id,
  psp.trade_mode,
  psp.status,
  psp.strategy_name,
  psp.strategy_quality_score,
  psp.setup_type,
  psp.thesis,
  psp.monitoring_plan,
  psp.exit_plan,
  psp.backtest_plan,
  psp.market_context,
  psp.strategy_context,
  psp.created_at,
  psp.updated_at,
  psp.closed_at,
  psp.strategy_state,
  psp.last_evaluation_at,
  psp.last_attention_at,
  NOW(),
  'orphan_paper_position_20260530'
FROM investment.position_strategy_profiles psp
WHERE EXISTS (
  SELECT 1
  FROM investment.positions p
  WHERE COALESCE(p.paper, false) = true
    AND p.symbol IS NOT DISTINCT FROM psp.symbol
    AND p.exchange IS NOT DISTINCT FROM psp.exchange
)
AND NOT EXISTS (
  SELECT 1
  FROM investment.position_strategy_profiles_archive archived
  WHERE archived.id = psp.id
    AND archived.archive_reason = 'orphan_paper_position_20260530'
);

INSERT INTO investment.positions_archive (
  symbol,
  amount,
  avg_price,
  unrealized_pnl,
  exchange,
  updated_at,
  paper,
  trade_mode,
  execution_mode,
  broker_account_mode,
  archived_at,
  archive_reason
)
SELECT
  p.symbol,
  p.amount,
  p.avg_price,
  p.unrealized_pnl,
  p.exchange,
  p.updated_at,
  p.paper,
  p.trade_mode,
  p.execution_mode,
  p.broker_account_mode,
  NOW(),
  'orphan_paper_position_20260530'
FROM investment.positions p
WHERE COALESCE(p.paper, false) = true
AND NOT EXISTS (
  SELECT 1
  FROM investment.positions_archive archived
  WHERE archived.symbol IS NOT DISTINCT FROM p.symbol
    AND archived.exchange IS NOT DISTINCT FROM p.exchange
    AND archived.paper IS NOT DISTINCT FROM p.paper
    AND archived.trade_mode IS NOT DISTINCT FROM p.trade_mode
    AND archived.execution_mode IS NOT DISTINCT FROM p.execution_mode
    AND archived.broker_account_mode IS NOT DISTINCT FROM p.broker_account_mode
    AND archived.updated_at IS NOT DISTINCT FROM p.updated_at
    AND archived.archive_reason = 'orphan_paper_position_20260530'
);

DELETE FROM investment.position_strategy_profiles psp
WHERE EXISTS (
  SELECT 1
  FROM investment.positions p
  WHERE COALESCE(p.paper, false) = true
    AND p.symbol IS NOT DISTINCT FROM psp.symbol
    AND p.exchange IS NOT DISTINCT FROM psp.exchange
);

DELETE FROM investment.positions
WHERE COALESCE(paper, false) = true;

COMMIT;
