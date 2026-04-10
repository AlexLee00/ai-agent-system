import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/hephaestos.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./hephaestos.legacy.js');
  }
})();

export const fetchUsdtBalance = loaded.fetchUsdtBalance;
export const fetchTicker = loaded.fetchTicker;
export const inspectPromotionCandidates = loaded.inspectPromotionCandidates;
export const simulateBuyDecision = loaded.simulateBuyDecision;
export const executeSignal = loaded.executeSignal;
export const processAllPendingSignals = loaded.processAllPendingSignals;
export default loaded.default ?? loaded;
