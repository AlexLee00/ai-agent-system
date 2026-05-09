// @ts-nocheck
import { getInvestmentNode } from '../nodes/index.ts';
import { executeApprovedDecision } from './pipeline-approved-decision.ts';
import { buildDecisionBridgeMeta } from './pipeline-decision-bridge.ts';

export function getDecisionNode(id) {
  const node = getInvestmentNode(id);
  if (!node) throw new Error(`노드 없음: ${id}`);
  return node;
}

export async function runApprovedDecision(args) {
  return executeApprovedDecision({
    ...args,
    buildDecisionBridgeMeta,
  });
}

function decisionSymbolKey(value) {
  return String(value?.symbol || '').trim().toUpperCase();
}

export function buildSignalDecisionTraceMeta({
  sessionId,
  exchange,
  decision,
  amountUsdt,
  tradeMode,
  predictiveObservation,
  midGapPromoted,
} = {}) {
  const blockMeta = decision?.block_meta || {};
  return {
    ...(blockMeta.entryTrigger ? { entryTrigger: blockMeta.entryTrigger } : {}),
    ...(blockMeta.predictiveValidation ? { predictiveValidation: blockMeta.predictiveValidation } : {}),
    ...(blockMeta.discoveryContext ? { discoveryContext: blockMeta.discoveryContext } : {}),
    decisionTrace: {
      sessionId: sessionId || null,
      market: exchange || null,
      symbol: decision?.symbol || null,
      action: decision?.action || null,
      sourceConfidence: decision?.confidence ?? null,
      sourceAmountUsdt: decision?.amount_usdt ?? null,
      effectiveAmountUsdt: amountUsdt ?? null,
      tradeMode: tradeMode || null,
      predictiveObservation: Boolean(predictiveObservation),
      midGapPromoted: Boolean(midGapPromoted),
      strategyRoute: decision?.strategy_route || decision?.strategyRoute || null,
      setupType: decision?.setup_type || decision?.strategy_route?.setupType || decision?.strategyRoute?.setupType || null,
      recordedAt: new Date().toISOString(),
    },
  };
}

export function mergePortfolioDecisionPredictiveEvidence(portfolioDecision = {}, symbolDecisions = []) {
  const evidenceBySymbol = new Map(
    (symbolDecisions || [])
      .filter((item) => decisionSymbolKey(item))
      .map((item) => [decisionSymbolKey(item), item]),
  );
  return {
    ...(portfolioDecision || {}),
    decisions: (portfolioDecision?.decisions || []).map((decision) => {
      const evidence = evidenceBySymbol.get(decisionSymbolKey(decision));
      if (!evidence) return decision;
      return {
        ...evidence,
        ...decision,
        exchange: decision.exchange || evidence.exchange,
        strategy_route: decision.strategy_route || evidence.strategy_route,
        strategyRoute: decision.strategyRoute || evidence.strategyRoute,
        setup_type: decision.setup_type || evidence.setup_type,
        entry_strategy: decision.entry_strategy || evidence.entry_strategy,
        entryPrice: decision.entryPrice ?? decision.entry_price ?? evidence.entryPrice ?? evidence.entry_price,
        entry_price: decision.entry_price ?? decision.entryPrice ?? evidence.entry_price ?? evidence.entryPrice,
        atr: decision.atr ?? evidence.atr,
        predictiveScore: decision.predictiveScore ?? evidence.predictiveScore,
        triggerHints: {
          ...(evidence.triggerHints || {}),
          ...(decision.triggerHints || {}),
        },
        block_meta: {
          ...(evidence.block_meta || {}),
          ...(decision.block_meta || {}),
        },
      };
    }),
  };
}
