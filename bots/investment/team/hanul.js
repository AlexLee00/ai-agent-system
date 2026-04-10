import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/hanul.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./hanul.legacy.js');
  }
})();

export const isKisSymbol = loaded.isKisSymbol;
export const isKisOverseasSymbol = loaded.isKisOverseasSymbol;
export const executeSignal = loaded.executeSignal;
export const executeOverseasSignal = loaded.executeOverseasSignal;
export const processAllPendingKisSignals = loaded.processAllPendingKisSignals;
export const processAllPendingKisOverseasSignals = loaded.processAllPendingKisOverseasSignals;
export default loaded.default ?? loaded;
