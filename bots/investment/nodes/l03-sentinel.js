import { analyze } from '../team/sentinel.js';
import { ANALYST_TYPES } from '../shared/signal.js';

const NODE_ID = 'L03';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  const result = await analyze(symbol, market);

  return {
    analyses: [{
      symbol,
      analyst: ANALYST_TYPES.SENTINEL,
      signal: result.signal || 'HOLD',
      confidence: result.confidence ?? 0.1,
      reasoning: result.reasoning || '',
      metadata: {
        ...(result.sentiment ? { sentiment: result.sentiment } : {}),
        ...(result.combinedScore != null ? { combinedScore: result.combinedScore } : {}),
        ...(result.metadata || {}),
      },
    }],
    partialFallback: false,
    errors: [],
  };
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'sentinel',
  run,
};
