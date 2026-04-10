import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/nemesis.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./nemesis.legacy.js');
  }
})();

export const RULES = loaded.RULES;
export const TPSL_LIMITS = loaded.TPSL_LIMITS;
export const validateDynamicTPSL = loaded.validateDynamicTPSL;
export const getDynamicRR = loaded.getDynamicRR;
export const calculateDynamicTPSL = loaded.calculateDynamicTPSL;
export const getDynamicRRByRegime = loaded.getDynamicRRByRegime;
export const getDynamicRRWeighted = loaded.getDynamicRRWeighted;
export const evaluateSignal = loaded.evaluateSignal;
export default loaded.default ?? loaded;
