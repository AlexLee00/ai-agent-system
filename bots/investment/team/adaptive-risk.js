import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/adaptive-risk.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./adaptive-risk.legacy.js');
  }
})();

export const isConfidenceDrivenRejection = loaded.isConfidenceDrivenRejection;
export const buildCryptoStarterAmount = loaded.buildCryptoStarterAmount;
export const evaluate = loaded.evaluate;
export default loaded.default ?? loaded;
