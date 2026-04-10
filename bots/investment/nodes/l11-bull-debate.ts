// @ts-nocheck
import { buildAnalysisSummary } from '../team/luna.ts';
import { runBullResearcher } from '../team/zeus.ts';
import { loadAnalysesForSession, loadLatestNodePayload } from './helpers.ts';

const NODE_ID = 'L11';

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

  const bearHit = await loadLatestNodePayload(sessionId, 'L12', symbol);
  const bearReasoning = bearHit?.payload?.bear?.reasoning || null;
  const summary = buildAnalysisSummary(analyses);
  const context = bearReasoning
    ? `${summary}\n\n[약세 주장 반박 요청]\n${bearReasoning}`
    : summary;

  const bull = await runBullResearcher(symbol, context, currentPriceFromAnalyses(analyses), market);
  return {
    symbol,
    market,
    source,
    round: bearReasoning ? 2 : 1,
    bull,
  };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'bull-debate',
  run,
};
