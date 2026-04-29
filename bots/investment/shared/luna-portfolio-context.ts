// @ts-nocheck
import * as db from './db.ts';
import {
  getAvailableBalance,
  getAvailableUSDT,
  getLunaBuyingPowerSnapshot,
} from './capital-manager.ts';
import { getDomesticBalance } from './kis-client.ts';

export async function buildLunaPortfolioContext(exchange = 'binance') {
  const positions = await db.getAllPositions(exchange, false);
  const todayPnl = await db.getTodayPnl(exchange);
  const posValue = positions.reduce((sum, position) => sum + (position.amount * position.avg_price), 0);

  const capitalSnapshot = await getLunaBuyingPowerSnapshot(
    exchange,
  ).catch(() => null);

  const usdtFree = capitalSnapshot?.balanceStatus === 'ok'
    ? capitalSnapshot.freeCash
    : capitalSnapshot?.balanceStatus === 'unavailable'
      ? 0
      : (exchange === 'binance'
          ? await getAvailableUSDT().catch(() => 0)
          : exchange === 'kis'
            ? await getDomesticBalance().then((balance) => Number(balance?.dnca_tot_amt || 0)).catch(() => 0)
            : 0);

  const availableBalance = exchange === 'binance'
    ? await getAvailableBalance().catch(() => usdtFree)
    : usdtFree;
  const totalAsset = exchange === 'binance'
    ? availableBalance + posValue
    : usdtFree + posValue;

  if (exchange === 'binance') {
    try {
      await db.insertAssetSnapshot(totalAsset, usdtFree);
    } catch {}
  }

  return {
    usdtFree,
    totalAsset,
    positionCount: positions.length,
    todayPnl,
    positions,
    capitalSnapshot,
    capitalMode: capitalSnapshot?.mode || null,
    reasonCode: capitalSnapshot?.reasonCode || null,
    buyableAmount: Number(capitalSnapshot?.buyableAmount || 0),
    balanceStatus: capitalSnapshot?.balanceStatus || 'unavailable',
  };
}

export async function inspectLunaPortfolioContext(exchange = 'binance') {
  const context = await buildLunaPortfolioContext(exchange);
  return {
    ...context,
    capitalMode: context?.capitalMode ?? context?.capitalSnapshot?.mode ?? null,
    reasonCode: context?.reasonCode ?? context?.capitalSnapshot?.reasonCode ?? null,
    buyableAmount: context?.buyableAmount ?? Number(context?.capitalSnapshot?.buyableAmount || 0),
    balanceStatus: context?.balanceStatus ?? context?.capitalSnapshot?.balanceStatus ?? 'unavailable',
  };
}
