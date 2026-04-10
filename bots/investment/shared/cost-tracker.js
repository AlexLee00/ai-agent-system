import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/cost-tracker.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./cost-tracker.legacy.js');
  }
})();

export const HAIKU_PRICING = loaded.HAIKU_PRICING;
export const tracker = loaded.tracker;
export const CostTracker = loaded.CostTracker;
export default loaded;
