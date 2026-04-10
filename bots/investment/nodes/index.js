import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/investment/nodes/index.js');

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./index.legacy.js');
  }
})();

export const INVESTMENT_NODES = loaded.INVESTMENT_NODES;
export const INVESTMENT_NODE_MAP = loaded.INVESTMENT_NODE_MAP;
export const getInvestmentNode = loaded.getInvestmentNode;
export default loaded.default ?? loaded;
