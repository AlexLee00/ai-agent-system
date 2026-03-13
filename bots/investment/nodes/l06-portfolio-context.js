import { inspectPortfolioContext } from '../team/luna.js';

const NODE_ID = 'L06';

async function run({ market }) {
  if (!market) throw new Error('market 필요');
  const portfolio = await inspectPortfolioContext(market);
  return {
    market,
    portfolio,
    source: 'luna',
  };
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'portfolio-context',
  run,
};
