// @ts-nocheck
/**
 * L12b — 네메시스(Risk) 토론 노드
 * N-Agent Debate 4번째 멤버: 리스크 관점 (경량 토론 버전)
 * evaluateSignal의 전체 승인 체인이 아닌 토론용 LLM 평가만 수행
 */
import { buildAnalysisSummary } from '../team/luna.ts';
import { runRiskDebater } from '../team/nemesis.ts';
import { loadAnalysesForSession } from './helpers.ts';

const NODE_ID = 'L12b';

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
  const risk = await runRiskDebater(symbol, summary, currentPriceFromAnalyses(analyses), market);
  return { symbol, market, source, risk };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'risk-debate',
  run,
};
