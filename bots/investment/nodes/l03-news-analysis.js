import { analyzeNews } from '../team/hermes.js';

const NODE_ID = 'L03';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  return analyzeNews(symbol, market);
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'news-analysis',
  run,
};
