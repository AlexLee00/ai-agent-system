import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/capital-manager.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./capital-manager.legacy.js');
  }
})();

export const config = loaded.config;
export const getCapitalConfig = loaded.getCapitalConfig;
export const formatDailyTradeLimitReason = loaded.formatDailyTradeLimitReason;
export const getAvailableUSDT = loaded.getAvailableUSDT;
export const getAvailableBalance = loaded.getAvailableBalance;
export const getTotalCapital = loaded.getTotalCapital;
export const getOpenPositions = loaded.getOpenPositions;
export const getDailyPnL = loaded.getDailyPnL;
export const getWeeklyPnL = loaded.getWeeklyPnL;
export const getDailyTradeCount = loaded.getDailyTradeCount;
export const checkCircuitBreaker = loaded.checkCircuitBreaker;
export const preTradeCheck = loaded.preTradeCheck;
export const calculatePositionSize = loaded.calculatePositionSize;
export const getCapitalStatus = loaded.getCapitalStatus;
export default loaded;
