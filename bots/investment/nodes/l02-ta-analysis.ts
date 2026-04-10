// @ts-nocheck
import { analyzeCryptoMTF, analyzeKisMTF, analyzeKisOverseasMTF } from '../team/aria.ts';

const NODE_ID = 'L02';

async function run({ market, symbol }) {
  if (!symbol) throw new Error('symbol 필요');
  if (market === 'binance') return analyzeCryptoMTF(symbol);
  if (market === 'kis') return analyzeKisMTF(symbol, false);
  if (market === 'kis_overseas') return analyzeKisOverseasMTF(symbol, false);
  throw new Error(`지원하지 않는 market: ${market}`);
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'ta-analysis',
  run,
};
