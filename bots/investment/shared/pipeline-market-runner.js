import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/pipeline-market-runner.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./pipeline-market-runner.legacy.js');
  }
})();

export const runMarketCollectPipeline = loaded.runMarketCollectPipeline;
export const summarizeNodeStatuses = loaded.summarizeNodeStatuses;
export const summarizeCollectWarnings = loaded.summarizeCollectWarnings;
export const buildCollectAlertMessage = loaded.buildCollectAlertMessage;
export default loaded;
