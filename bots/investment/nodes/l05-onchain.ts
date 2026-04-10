// @ts-nocheck
import { analyzeOnchain } from '../team/oracle.ts';

const NODE_ID = 'L05';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  if (market !== 'binance') {
    return { skipped: true, reason: 'onchain은 크립토 전용', symbol, market };
  }
  return analyzeOnchain(symbol);
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'onchain',
  run,
};
