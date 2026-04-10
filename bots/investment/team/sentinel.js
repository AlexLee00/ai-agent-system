import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/team/sentinel.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./sentinel.legacy.js');
  }
})();

export const combineSentinelResult = loaded.combineSentinelResult;
export const analyze = loaded.analyze;
export default loaded.default ?? loaded;
