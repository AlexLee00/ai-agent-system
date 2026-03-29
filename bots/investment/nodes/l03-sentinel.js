import { analyzeNews } from '../team/hermes.js';
import { analyzeSentiment } from '../team/sophia.js';
import { ANALYST_TYPES } from '../shared/signal.js';

const NODE_ID = 'L03';

function normalizeWrappedAnalysis(symbol, analyst, result = {}) {
  return {
    symbol,
    analyst,
    signal: result.signal || 'HOLD',
    confidence: result.confidence ?? 0.1,
    reasoning: result.reasoning || '',
    metadata: {
      ...(result.sentiment ? { sentiment: result.sentiment } : {}),
      ...(result.combinedScore != null ? { combinedScore: result.combinedScore } : {}),
    },
  };
}

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');

  const analyses = [];
  const errors = [];

  try {
    const news = await analyzeNews(symbol, market);
    analyses.push(normalizeWrappedAnalysis(symbol, ANALYST_TYPES.NEWS, news));
  } catch (error) {
    errors.push(`news:${error.message}`);
  }

  try {
    const sentiment = await analyzeSentiment(symbol, market);
    analyses.push(normalizeWrappedAnalysis(symbol, ANALYST_TYPES.SENTIMENT, sentiment));
  } catch (error) {
    errors.push(`sentiment:${error.message}`);
  }

  if (analyses.length === 0) {
    throw new Error(`sentinel_failed:${errors.join(' | ') || 'unknown'}`);
  }

  return {
    analyses,
    partialFallback: errors.length > 0,
    errors,
  };
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'sentinel',
  run,
};
