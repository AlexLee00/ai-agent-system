import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/onchain-data.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./onchain-data.legacy.js');
  }
})();

export const getFundingRate = loaded.getFundingRate;
export const getOpenInterest = loaded.getOpenInterest;
export const getLongShortRatio = loaded.getLongShortRatio;
export const getOnchainSummary = loaded.getOnchainSummary;
export default loaded;
