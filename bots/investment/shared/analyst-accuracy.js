import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/analyst-accuracy.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./analyst-accuracy.legacy.js');
  }
})();

export const ANALYSTS = loaded.ANALYSTS;
export const getActiveAnalysts = loaded.getActiveAnalysts;
export const getWeeklyAccuracy = loaded.getWeeklyAccuracy;
export const getWeeklyAccuracyHistory = loaded.getWeeklyAccuracyHistory;
export const calculateWeightAdjustment = loaded.calculateWeightAdjustment;
export const buildAccuracyReport = loaded.buildAccuracyReport;
export const normalizeWeights = loaded.normalizeWeights;
export default loaded;
