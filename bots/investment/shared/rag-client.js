import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/rag-client.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./rag-client.legacy.js');
  }
})();

export const getRagGuardStatus = loaded.getRagGuardStatus;
export const initSchema = loaded.initSchema;
export const search = loaded.search;
export const store = loaded.store;
export const storeBatch = loaded.storeBatch;
export default loaded;
