import { analyzeSentiment } from '../team/sophia.js';

const NODE_ID = 'L04';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  return analyzeSentiment(symbol, market);
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'sentiment',
  run,
};
