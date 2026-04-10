import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/oracle.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./oracle.legacy.js');
  }
})();

export const fetchFearGreed = loaded.fetchFearGreed;
export const fetchFundingRate = loaded.fetchFundingRate;
export const fetchLongShortRatio = loaded.fetchLongShortRatio;
export const fetchOpenInterest = loaded.fetchOpenInterest;
export const analyzeOnchain = loaded.analyzeOnchain;
export default loaded.default ?? loaded;
