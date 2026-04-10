// @ts-nocheck
import { inspectPortfolioContext } from '../team/luna.ts';
import { evaluateSignal } from '../team/nemesis.ts';
import { fetchNodeArtifacts } from '../shared/node-runner.ts';
import { loadAnalysesForSession } from './helpers.ts';

const NODE_ID = 'L21';

async function run({ sessionId, market, symbol }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const decisionHit = (await fetchNodeArtifacts(sessionId, 'L13', { symbol, limit: 1 }).catch(() => []))[0] || null;
  const decision = decisionHit?.payload?.decision || null;
  if (!decision?.action || decision.action === 'HOLD') {
    return {
      symbol,
      market,
      skipped: true,
      reason: decision?.action === 'HOLD' ? 'HOLD 신호' : 'L13 결정 없음',
      decision,
    };
  }

  const { analyses } = await loadAnalysesForSession(sessionId, symbol, market);
  const taAnalysis = analyses.find(item => item?.metadata?.currentPrice != null || item?.metadata?.atrRatio != null);
  const portfolio = await inspectPortfolioContext(market);

  const riskResult = await evaluateSignal({
    symbol,
    action: decision.action,
    amount_usdt: decision.amount_usdt,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    exchange: market,
  }, {
    totalUsdt: portfolio.totalAsset,
    atrRatio: taAnalysis?.metadata?.atrRatio ?? null,
    currentPrice: taAnalysis?.metadata?.currentPrice ?? null,
    persist: false,
  });

  return {
    symbol,
    market,
    decision,
    portfolio: {
      totalAsset: portfolio.totalAsset,
      positionCount: portfolio.positionCount,
      usdtFree: portfolio.usdtFree,
    },
    risk: riskResult,
  };
}

export default {
  id: NODE_ID,
  type: 'risk',
  label: 'llm-risk',
  run,
};
