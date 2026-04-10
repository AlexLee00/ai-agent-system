import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/llm-client.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./llm-client.legacy.js');
  }
})();

export const PAPER_MODE = loaded.PAPER_MODE;
export const GROQ_SCOUT_MODEL = loaded.GROQ_SCOUT_MODEL;
export const GPT_OSS_20B_MODEL = loaded.GPT_OSS_20B_MODEL;
export const OPENAI_PERF_MODEL = loaded.OPENAI_PERF_MODEL;
export const HAIKU_MODEL = loaded.HAIKU_MODEL;
export const OPENAI_MINI_MODEL = loaded.OPENAI_MINI_MODEL;
export const parseJSON = loaded.parseJSON;
export const callLLM = loaded.callLLM;
export const cachedCallLLM = loaded.cachedCallLLM;
export default loaded;
