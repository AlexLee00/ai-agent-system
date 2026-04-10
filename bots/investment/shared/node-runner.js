import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/node-runner.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./node-runner.legacy.js');
  }
})();

export const createPipelineSession = loaded.createPipelineSession;
export const storeNodeArtifact = loaded.storeNodeArtifact;
export const fetchNodeArtifacts = loaded.fetchNodeArtifacts;
export const runNode = loaded.runNode;
export const recordNodeResult = loaded.recordNodeResult;
export default loaded;
