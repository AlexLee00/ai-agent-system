// @ts-nocheck
/**
 * L13 — 루나 최종 결정 노드 (4-Agent Vote 통합)
 *
 * 토론 참여자 + 가중치:
 *   🐂 제우스  (Bull)  — L11  — weight 0.8
 *   🐻 아테나  (Bear)  — L12  — weight 0.8
 *   📊 헤르메스(Quant) — L11b — weight 1.0
 *   🛡 네메시스(Risk)  — L12b — weight 1.5  (리스크 보수 가중)
 *   🎯 루나           — L13  — getSymbolDecision 최종 합성
 */
import { getSymbolDecision } from '../team/luna.ts';
import { loadAnalysesForSession, loadLatestNodePayload } from './helpers.ts';

const NODE_ID = 'L13';

// 4-에이전트 투표: Risk Verdict → 행동 점수 매핑
const RISK_VERDICT_BIAS: Record<string, number> = {
  PROCEED: +1,
  CAUTION:  0,
  AVOID:   -2,
};

function computeDebateConsensus(debate: {
  bull: unknown;
  bear: unknown;
  quant: unknown;
  risk: unknown;
}): { consensusAction: string; consensusConfidence: number; summary: string } {
  const { bull, bear, quant, risk } = debate;

  // 각 에이전트 점수 합산 (+1 = 매수, -1 = 매도, 0 = 중립)
  const scores: number[] = [];
  const weights: number[] = [];

  if (bull?.upsidePct != null) {
    scores.push(bull.upsidePct > 0 ? 1 : -1);
    weights.push(0.8);
  }
  if (bear?.downsidePct != null || bear?.reasoning) {
    scores.push(-0.5); // bear는 기본 매도 편향
    weights.push(0.8);
  }
  if (quant?.expectedReturnPct != null) {
    scores.push(quant.expectedReturnPct > 0 ? 1 : -1);
    weights.push(1.0);
  }
  if (risk?.verdict) {
    scores.push(RISK_VERDICT_BIAS[risk.verdict] ?? 0);
    weights.push(1.5);
  }

  if (!scores.length) {
    return { consensusAction: 'HOLD', consensusConfidence: 0.3, summary: '토론 데이터 없음' };
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weightedScore = scores.reduce((acc, s, i) => acc + s * weights[i], 0) / totalWeight;

  const consensusAction = weightedScore > 0.2 ? 'BUY' : weightedScore < -0.2 ? 'SELL' : 'HOLD';
  const consensusConfidence = Math.min(0.95, Math.max(0.3, Math.abs(weightedScore) * 0.8 + 0.3));

  const verdicts = [
    bull ? `제우스(+${bull.upsidePct?.toFixed(1) ?? '?'}%)` : null,
    bear ? `아테나(하방)` : null,
    quant ? `헤르메스(${quant.expectedReturnPct?.toFixed(1) ?? '?'}%)` : null,
    risk ? `네메시스(${risk.verdict})` : null,
  ].filter(Boolean).join(', ');

  return { consensusAction, consensusConfidence, summary: `[4-Agent] ${verdicts} → ${consensusAction}` };
}

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const { analyses, source } = await loadAnalysesForSession(sessionId, symbol, market);
  if (!analyses.length) {
    return { symbol, market, source, decision: null, skipped: true, reason: '분석 결과 없음' };
  }

  const [bullHit, bearHit, quantHit, riskHit] = await Promise.all([
    loadLatestNodePayload(sessionId, 'L11',  symbol),
    loadLatestNodePayload(sessionId, 'L12',  symbol),
    loadLatestNodePayload(sessionId, 'L11b', symbol),
    loadLatestNodePayload(sessionId, 'L12b', symbol),
  ]);

  const debate = {
    bull:  bullHit?.payload?.bull  || null,
    bear:  bearHit?.payload?.bear  || null,
    quant: quantHit?.payload?.quant || null,
    risk:  riskHit?.payload?.risk  || null,
  };

  const hasDebate = Object.values(debate).some(Boolean);

  // 4-에이전트 합의 사전 계산 → luna의 최종 판단에 컨텍스트로 전달
  const consensus = hasDebate ? computeDebateConsensus(debate) : null;
  const enrichedDebate = consensus ? { ...debate, _consensus: consensus } : debate;

  const decision = await getSymbolDecision(symbol, analyses, market, hasDebate ? enrichedDebate : null);
  return {
    symbol,
    market,
    source,
    analyses_count: analyses.length,
    debate: hasDebate ? enrichedDebate : null,
    decision,
  };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'final-decision',
  run,
};
