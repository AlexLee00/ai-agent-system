import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/report.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./report.legacy.js');
  }
})();

export const sendTelegram = loaded.sendTelegram;
export const notifySignal = loaded.notifySignal;
export const notifyTrade = loaded.notifyTrade;
export const notifyKisSignal = loaded.notifyKisSignal;
export const notifyKisOverseasSignal = loaded.notifyKisOverseasSignal;
export const notifyRiskRejection = loaded.notifyRiskRejection;
export const notifyTradeSkip = loaded.notifyTradeSkip;
export const notifyCircuitBreaker = loaded.notifyCircuitBreaker;
export const notifyError = loaded.notifyError;
export const notifyJournalEntry = loaded.notifyJournalEntry;
export const notifyDailyJournal = loaded.notifyDailyJournal;
export const notifySettlement = loaded.notifySettlement;
export const notifyCapitalStatus = loaded.notifyCapitalStatus;
export const notifyWeeklyReflection = loaded.notifyWeeklyReflection;
export const notifyCycleSummary = loaded.notifyCycleSummary;
export default loaded;
