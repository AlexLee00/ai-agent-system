import l01PreScreen from './l01-pre-screen.js';
import l02TaAnalysis from './l02-ta-analysis.js';
import l03NewsAnalysis from './l03-news-analysis.js';
import l04Sentiment from './l04-sentiment.js';
import l05Onchain from './l05-onchain.js';
import l06PortfolioContext from './l06-portfolio-context.js';
import l10SignalFusion from './l10-signal-fusion.js';
import l13FinalDecision from './l13-final-decision.js';
import l21LlmRisk from './l21-llm-risk.js';

export const INVESTMENT_NODES = [
  l01PreScreen,
  l02TaAnalysis,
  l03NewsAnalysis,
  l04Sentiment,
  l05Onchain,
  l06PortfolioContext,
  l10SignalFusion,
  l13FinalDecision,
  l21LlmRisk,
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
