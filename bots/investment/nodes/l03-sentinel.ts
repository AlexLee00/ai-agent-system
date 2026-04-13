// @ts-nocheck
import { analyze } from '../team/sentinel.ts';
import { ANALYST_TYPES } from '../shared/signal.ts';

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
        ...(Array.isArray(result.errors) && result.errors.length > 0 ? { errors: result.errors } : {}),
        ...(result.metadata || {}),
      },
    }],
    partialFallback: Boolean(result.partialFallback),
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'sentinel',
  run,
};
