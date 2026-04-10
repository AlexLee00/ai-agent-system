import { fuseSignals } from '../team/luna.js';
import { loadAnalysesForSession } from './helpers.js';

const NODE_ID = 'L10';

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const { analyses, source } = await loadAnalysesForSession(sessionId, symbol, market);
  if (!analyses.length) {
    return {
      symbol,
      market,
      source,
      analyses_count: 0,
      fused: null,
      skipped: true,
      reason: '분석 결과 없음',
    };
  }

  return {
    symbol,
    market,
    source,
    analyses_count: analyses.length,
    fused: fuseSignals(analyses),
  };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'signal-fusion',
  run,
};
