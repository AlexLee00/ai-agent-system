import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/pipeline-db.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./pipeline-db.legacy.js');
  }
})();

export const initPipelineSchema = loaded.initPipelineSchema;
export const createPipelineRun = loaded.createPipelineRun;
export const finishPipelineRun = loaded.finishPipelineRun;
export const startNodeRun = loaded.startNodeRun;
export const finishNodeRun = loaded.finishNodeRun;
export const getPipelineRun = loaded.getPipelineRun;
export const getNodeRuns = loaded.getNodeRuns;
export const getNodeRunsForSymbol = loaded.getNodeRunsForSymbol;
export default loaded;
