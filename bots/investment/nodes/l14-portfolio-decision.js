import { getPortfolioDecision, inspectPortfolioContext } from '../team/luna.js';
import { fetchNodeArtifacts } from '../shared/node-runner.js';

const NODE_ID = 'L14';

async function run({ sessionId, market, symbolDecisions = null, portfolio = null }) {
  if (!sessionId) throw new Error('sessionId 필요');

  let decisions = symbolDecisions;
  if (!Array.isArray(decisions)) {
    const hits = await fetchNodeArtifacts(sessionId, 'L13', { limit: 20 }).catch(() => []);
    decisions = hits
      .map(hit => hit.payload?.decision ? ({ symbol: hit.payload.symbol, exchange: market, ...hit.payload.decision }) : null)
      .filter(Boolean);
  }

  if (!decisions.length) {
    return {
      market,
      skipped: true,
      reason: '심볼 판단 없음',
      decisions: [],
    };
  }

  const currentPortfolio = portfolio || await inspectPortfolioContext(market);
  const portfolioDecision = await getPortfolioDecision(decisions, currentPortfolio, market);
  return {
    market,
    decisions,
    portfolio: {
      usdtFree: currentPortfolio.usdtFree,
      totalAsset: currentPortfolio.totalAsset,
      positionCount: currentPortfolio.positionCount,
      todayPnl: currentPortfolio.todayPnl,
    },
    portfolioDecision,
  };
}

export default {
  id: NODE_ID,
  type: 'decision',
  label: 'portfolio-decision',
  run,
};
