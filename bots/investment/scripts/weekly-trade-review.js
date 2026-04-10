import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/scripts/weekly-trade-review.js',
);

try {
  await import(pathToFileURL(runtimePath).href);
} catch (error) {
  if (error && error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  await import('./weekly-trade-review.legacy.js');
}
