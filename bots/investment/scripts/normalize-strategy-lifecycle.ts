// @ts-nocheck

import * as db from '../shared/db.ts';

async function main() {
  await db.initSchema();

  const livePositions = await db.getAllPositions(null, false);
  let updated = 0;
  const rows = [];

  for (const position of livePositions) {
    const profile = await db.getPositionStrategyProfile(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode,
      status: 'active',
    }).catch(() => null);
    if (!profile) continue;

    const lifecycleStatus = String(profile?.strategy_state?.lifecycleStatus || '').trim().toLowerCase();
    if (lifecycleStatus) continue;

    const updatedRow = await db.updatePositionStrategyProfileState(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode,
      strategyState: {
        lifecycleStatus: 'holding',
        latestRecommendation: 'HOLD',
        latestReasonCode: 'lifecycle_normalized',
        latestReason: 'active live position lifecycle normalized to holding',
        updatedBy: 'normalize_strategy_lifecycle',
      },
      lastEvaluationAt: new Date().toISOString(),
    }).catch(() => null);

    if (updatedRow) {
      updated += 1;
      rows.push({
        symbol: position.symbol,
        exchange: position.exchange,
        lifecycleStatus: updatedRow?.strategy_state?.lifecycleStatus || 'holding',
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    updated,
    rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2));
  process.exit(1);
});
