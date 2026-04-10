import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/scout-intel.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./scout-intel.legacy.js');
  }
})();

export const loadLatestScoutIntel = loaded.loadLatestScoutIntel;
export const getScoutSignalForSymbol = loaded.getScoutSignalForSymbol;
export const boostCandidatesWithScout = loaded.boostCandidatesWithScout;
export default loaded;
