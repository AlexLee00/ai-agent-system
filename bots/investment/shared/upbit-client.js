import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/upbit-client.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./upbit-client.legacy.js');
  }
})();

export const getUpbitKrwBalance = loaded.getUpbitKrwBalance;
export const getUpbitUsdtBalance = loaded.getUpbitUsdtBalance;
export const buyUsdtWithKrw = loaded.buyUsdtWithKrw;
export const getBinanceDepositAddress = loaded.getBinanceDepositAddress;
export const getRecentKrwDepositTime = loaded.getRecentKrwDepositTime;
export const withdrawUsdtToAddress = loaded.withdrawUsdtToAddress;
export default loaded;
