import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/kis-client.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./kis-client.legacy.js');
  }
})();

export const getDomesticPrice = loaded.getDomesticPrice;
export const getOverseasPrice = loaded.getOverseasPrice;
export const getOverseasQuote = loaded.getOverseasQuote;
export const marketBuy = loaded.marketBuy;
export const marketSell = loaded.marketSell;
export const marketBuyOverseas = loaded.marketBuyOverseas;
export const marketSellOverseas = loaded.marketSellOverseas;
export const getDomesticBalance = loaded.getDomesticBalance;
export const getDomesticRanking = loaded.getDomesticRanking;
export const getVolumeRank = loaded.getVolumeRank;
export const getOverseasBalance = loaded.getOverseasBalance;
export default loaded;
