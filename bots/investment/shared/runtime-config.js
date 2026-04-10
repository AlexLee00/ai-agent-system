import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/runtime-config.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./runtime-config.legacy.js');
  }
})();

export const getInvestmentRuntimeConfig = loaded.getInvestmentRuntimeConfig;
export const isDynamicTpSlEnabled = loaded.isDynamicTpSlEnabled;
export const getLunaRuntimeConfig = loaded.getLunaRuntimeConfig;
export const getSignalDedupeWindowMinutes = loaded.getSignalDedupeWindowMinutes;
export const getMockUntradableSymbolCooldownMinutes = loaded.getMockUntradableSymbolCooldownMinutes;
export const getValidationSoftBudgetConfig = loaded.getValidationSoftBudgetConfig;
export const isSameDaySymbolReentryBlockEnabled = loaded.isSameDaySymbolReentryBlockEnabled;
export const getLunaStockStrategyProfile = loaded.getLunaStockStrategyProfile;
export const getNemesisRuntimeConfig = loaded.getNemesisRuntimeConfig;
export const getTimeModeRuntimeConfig = loaded.getTimeModeRuntimeConfig;
export const getInvestmentLLMPolicyConfig = loaded.getInvestmentLLMPolicyConfig;
export default loaded;
