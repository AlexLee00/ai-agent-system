import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/signal.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./signal.legacy.js');
  }
})();

export const ACTIONS = loaded.ACTIONS;
export const SIGNAL_STATUS = loaded.SIGNAL_STATUS;
export const ANALYST_TYPES = loaded.ANALYST_TYPES;
export const validateSignal = loaded.validateSignal;
export const validateAnalysis = loaded.validateAnalysis;
export const checkSafetyGates = loaded.checkSafetyGates;
export const executeSignal = loaded.executeSignal;
export default loaded;
