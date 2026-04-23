// @ts-nocheck
import { analyzeStockFlow } from '../team/stock-flow.ts';
import { ANALYST_TYPES } from '../shared/signal.ts';

const NODE_ID = 'L04';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  if (market !== 'kis' && market !== 'kis_overseas') {
    return { analyses: [] };
  }

  const result = await analyzeStockFlow(symbol, market);
  return {
    analyses: [{
      symbol,
      analyst: ANALYST_TYPES.MARKET_FLOW,
      signal: result.signal || 'HOLD',
      confidence: result.confidence ?? 0.1,
      reasoning: result.reasoning || '',
      metadata: result.metadata || {},
    }],
  };
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'market-flow',
  run,
};
