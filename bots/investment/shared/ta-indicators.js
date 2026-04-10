import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/ta-indicators.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./ta-indicators.legacy.js');
  }
})();

export const calcRSI = loaded.calcRSI;
export const calcMACD = loaded.calcMACD;
export const calcBollingerBands = loaded.calcBollingerBands;
export const calcATR = loaded.calcATR;
export const calcEMA = loaded.calcEMA;
export const calcSMA = loaded.calcSMA;
export default loaded;
