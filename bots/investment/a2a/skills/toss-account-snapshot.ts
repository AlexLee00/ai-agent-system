// @ts-nocheck

import { createTossBrokerAdapter } from '../../shared/brokers/toss-adapter.ts';
import { buildTossBalanceShadowComparison } from '../../shared/luna-toss-balance-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

export const TOSS_ACCOUNT_SNAPSHOT_SKILL = 'toss-account-snapshot';

function summarizeHoldings(holdingsResult = {}) {
  const holdings = Array.isArray(holdingsResult.holdings) ? holdingsResult.holdings : [];
  const marketValue = holdings.reduce((sum, row) => sum + (Number(row.marketValue) || 0), 0);
  return {
    count: holdings.length,
    marketValue,
    symbols: holdings.map((row) => row.symbol).filter(Boolean).slice(0, 20),
    skipped: holdingsResult.skipped === true,
    skippedReason: holdingsResult.skippedReason || null,
  };
}

export function createTossAccountSnapshotHandler(options: Record<string, any> = {}) {
  return async function tossAccountSnapshot(params: any = {}) {
    const market = params.market || 'domestic';
    const adapter = options.adapter || createTossBrokerAdapter(options.tossOptions || {});
    const safe = async (fn: any, fallback: any) => {
      try {
        return await fn();
      } catch (error) {
        return {
          ...fallback,
          skipped: true,
          skippedReason: error?.message || String(error),
        };
      }
    };
    const [holdings, buyingPower, balanceShadow] = await Promise.all([
      safe(() => (options.getHoldings || adapter.getHoldings)(market, params), { provider: 'toss', holdings: [] }),
      safe(() => (options.getBuyingPower || adapter.getBuyingPower)({
        market,
        currency: market === 'overseas' ? 'USD' : 'KRW',
      }), { provider: 'toss', type: 'buying_power' }),
      safe(() => (options.buildBalanceShadow || buildTossBalanceShadowComparison)({
        market,
        queryFn: options.queryFn,
      }, { adapter, queryFn: options.queryFn }), { ok: false, deltas: [] }),
    ]);
    return {
      status: 'completed',
      output: {
        ok: true,
        skill: TOSS_ACCOUNT_SNAPSHOT_SKILL,
        market,
        advisoryOnly: true,
        shadowMode: true,
        liveMutation: false,
        placed: false,
        summary: summarizeHoldings(holdings),
        buyingPower,
        balanceShadow,
      },
      metadata: {
        liveMutation: false,
        protectedPidMutation: false,
      },
    };
  };
}

export function registerTossAccountSnapshotSkill(options: Record<string, any> = {}) {
  registerSkillHandler(TOSS_ACCOUNT_SNAPSHOT_SKILL, createTossAccountSnapshotHandler(options) as any);
}

export default {
  TOSS_ACCOUNT_SNAPSHOT_SKILL,
  createTossAccountSnapshotHandler,
  registerTossAccountSnapshotSkill,
};
