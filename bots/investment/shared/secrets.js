import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/secrets.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./secrets.legacy.js');
  }
})();

export const initHubSecrets = loaded.initHubSecrets;
export const loadSecrets = loaded.loadSecrets;
export const getTradingMode = loaded.getTradingMode;
export const isPaperMode = loaded.isPaperMode;
export const formatExecutionTag = loaded.formatExecutionTag;
export const getExecutionMode = loaded.getExecutionMode;
export const getInvestmentTradeMode = loaded.getInvestmentTradeMode;
export const isValidationTradeMode = loaded.isValidationTradeMode;
export const getInvestmentGuardScope = loaded.getInvestmentGuardScope;
export const isTestnet = loaded.isTestnet;
export const getBrokerAccountMode = loaded.getBrokerAccountMode;
export const describeModePair = loaded.describeModePair;
export const getSymbols = loaded.getSymbols;
export const getCryptoScreeningMaxDynamic = loaded.getCryptoScreeningMaxDynamic;
export const getDomesticScreeningMaxDynamic = loaded.getDomesticScreeningMaxDynamic;
export const getOverseasScreeningMaxDynamic = loaded.getOverseasScreeningMaxDynamic;
export const getKisSymbols = loaded.getKisSymbols;
export const getKisOverseasSymbols = loaded.getKisOverseasSymbols;
export const isNyseHoliday = loaded.isNyseHoliday;
export const isKisHoliday = loaded.isKisHoliday;
export const isKisMarketOpen = loaded.isKisMarketOpen;
export const getKisMarketStatus = loaded.getKisMarketStatus;
export const isKisOverseasMarketOpen = loaded.isKisOverseasMarketOpen;
export const getKisOverseasMarketStatus = loaded.getKisOverseasMarketStatus;
export const isKisPaper = loaded.isKisPaper;
export const getKisExecutionModeInfo = loaded.getKisExecutionModeInfo;
export const getMarketExecutionModeInfo = loaded.getMarketExecutionModeInfo;
export const isBinancePaper = loaded.isBinancePaper;
export const getKisAccount = loaded.getKisAccount;
export const hasKisApiKey = loaded.hasKisApiKey;
export const getKisAppKey = loaded.getKisAppKey;
export const getKisAppSecret = loaded.getKisAppSecret;
export default loaded;
