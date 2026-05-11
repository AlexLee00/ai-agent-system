// @ts-nocheck
/**
 * L11b — 헤르메스(Quant) 토론 노드
 * N-Agent Debate 4번째 멤버: 뉴스 + 퀀트 중립 관점
 * TradingAgents (Yang 2024) 패턴 적용
 */
import { buildAnalysisSummary } from '../team/luna.ts';
import { runQuantResearcher } from '../team/hermes.ts';
import { loadAnalysesForSession } from './helpers.ts';

const NODE_ID = 'L11b';

function currentPriceFromAnalyses(analyses = []) {
  return analyses.find(item => item?.metadata?.currentPrice != null)?.metadata?.currentPrice ?? null;
}

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const { analyses, source } = await loadAnalysesForSession(sessionId, symbol, market);
  if (!analyses.length) {
    return { symbol, market, source, skipped: true, reason: '분석 결과 없음' };
  }

  const summary = buildAnalysisSummary(analyses);
  const quant = await runQuantResearcher(symbol, summary, currentPriceFromAnalyses(analyses), market);
  return { symbol, market, source, quant };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'quant-debate',
  run,
};
