import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/argos.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./argos.legacy.js');
  }
})();

export const CORE_CRYPTO = loaded.CORE_CRYPTO;
export const CORE_KIS = loaded.CORE_KIS;
export const CORE_OVERSEAS = loaded.CORE_OVERSEAS;
export const fetchFearGreedIndex = loaded.fetchFearGreedIndex;
export const collectStrategies = loaded.collectStrategies;
export const recommendStrategy = loaded.recommendStrategy;
export const screenCryptoSymbols = loaded.screenCryptoSymbols;
export const screenDomesticSymbols = loaded.screenDomesticSymbols;
export const screenOverseasSymbols = loaded.screenOverseasSymbols;
export const screenAllMarkets = loaded.screenAllMarkets;
export default loaded.default ?? loaded;
