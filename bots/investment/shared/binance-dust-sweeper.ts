// @ts-nocheck
/**
 * shared/binance-dust-sweeper.ts
 *
 * Binance dust cleanup facade.
 * Default behavior is always dry-run unless LUNA_DUST_SWEEP_ENABLED=true and
 * the caller explicitly passes dryRun=false.
 */

import { sweepBinanceDust } from '../scripts/liquidate-binance-dust.ts';

export async function runBinanceDustSweeper({ dryRun = true, maxUsdt = 10 } = {}) {
  const enabled = process.env.LUNA_DUST_SWEEP_ENABLED === 'true';
  return sweepBinanceDust({
    dryRun: enabled ? dryRun !== false : true,
    maxUsdt,
  });
}

export default { runBinanceDustSweeper };
