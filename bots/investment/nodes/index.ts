// @ts-nocheck
import l01PreScreen from './l01-pre-screen.ts';
import l02TaAnalysis from './l02-ta-analysis.ts';
import l03Sentinel from './l03-sentinel.ts';
import l05Onchain from './l05-onchain.ts';
import l06PortfolioContext from './l06-portfolio-context.ts';
import l10SignalFusion from './l10-signal-fusion.ts';
import l11BullDebate from './l11-bull-debate.ts';
import l12BearDebate from './l12-bear-debate.ts';
import l13FinalDecision from './l13-final-decision.ts';
import l14PortfolioDecision from './l14-portfolio-decision.ts';
import l21LlmRisk from './l21-llm-risk.ts';
import l30SignalSave from './l30-signal-save.ts';
import l31OrderExecute from './l31-order-execute.ts';
import l32Notify from './l32-notify.ts';
import l33RagStore from './l33-rag-store.ts';
import l34Journal from './l34-journal.ts';

export const INVESTMENT_NODES = [
  l01PreScreen,
  l02TaAnalysis,
  l03Sentinel,
  l05Onchain,
  l06PortfolioContext,
  l10SignalFusion,
  l11BullDebate,
  l12BearDebate,
  l13FinalDecision,
  l14PortfolioDecision,
  l21LlmRisk,
  l30SignalSave,
  l31OrderExecute,
  l32Notify,
  l33RagStore,
  l34Journal,
];

export const INVESTMENT_NODE_MAP = new Map(
  INVESTMENT_NODES.map(node => [String(node.id).toUpperCase(), node]),
);

export function getInvestmentNode(nodeId) {
  if (!nodeId) return null;
  return INVESTMENT_NODE_MAP.get(String(nodeId).toUpperCase()) || null;
}

export default {
  INVESTMENT_NODES,
  INVESTMENT_NODE_MAP,
  getInvestmentNode,
};
