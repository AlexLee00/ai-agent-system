// @ts-nocheck
import { buildAnalysisSummary } from '../team/luna.ts';
import { runBearResearcher } from '../team/athena.ts';
import { loadAnalysesForSession, loadLatestNodePayload } from './helpers.ts';

const NODE_ID = 'L12';

function currentPriceFromAnalyses(analyses = []) {
  return analyses.find(item => item?.metadata?.currentPrice != null)?.metadata?.currentPrice ?? null;
}

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const { analyses, source } = await loadAnalysesForSession(sessionId, symbol, market);
  if (!analyses.length) {
    return {
      symbol,
      market,
      source,
      skipped: true,
      reason: '분석 결과 없음',
    };
  }

  const bullHit = await loadLatestNodePayload(sessionId, 'L11', symbol);
  const bullReasoning = bullHit?.payload?.bull?.reasoning || null;
  const summary = buildAnalysisSummary(analyses);
  const context = bullReasoning
    ? `${summary}\n\n[강세 주장 반박 요청]\n${bullReasoning}`
    : summary;

  const bear = await runBearResearcher(symbol, context, currentPriceFromAnalyses(analyses), market);
  return {
    symbol,
    market,
    source,
    round: bullReasoning ? 2 : 1,
    bear,
  };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'bear-debate',
  run,
};
