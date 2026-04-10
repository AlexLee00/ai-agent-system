import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/llm.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./llm.legacy.js');
  }
})();

export const callLLM = loaded.callLLM;
export const parseJSON = loaded.parseJSON;
export const PAPER_MODE = loaded.PAPER_MODE;
export const GROQ_SCOUT_MODEL = loaded.GROQ_SCOUT_MODEL;
export const HAIKU_MODEL = loaded.HAIKU_MODEL;
export const callHaiku = loaded.callHaiku;
export const callFreeLLM = loaded.callFreeLLM;
export default loaded;
