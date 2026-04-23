// @ts-nocheck

import * as db from '../shared/db.ts';
import { getInvestmentSyncRuntimeConfig } from '../shared/runtime-config.ts';

function getDustThresholdUsdt() {
  const syncRuntime = getInvestmentSyncRuntimeConfig();
  const threshold = Number(syncRuntime?.cryptoMinNotionalUsdt);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 10;
}

async function main() {
  await db.initSchema();

  const dustThresholdUsdt = getDustThresholdUsdt();
  const livePositions = await db.getAllPositions('binance', false);
  const rows = [];

  for (const position of livePositions) {
    const notionalUsdt = Number(position.amount || 0) * Number(position.avg_price || 0);
    if (!(notionalUsdt > 0) || notionalUsdt >= dustThresholdUsdt) continue;

    const profile = await db.getPositionStrategyProfile(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      status: 'active',
    }).catch(() => null);
    if (!profile) continue;

    await db.closePositionStrategyProfile(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
    }).catch(() => null);

    rows.push({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      notionalUsdt,
      strategyName: profile.strategy_name || null,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    dustThresholdUsdt,
    retired: rows.length,
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
