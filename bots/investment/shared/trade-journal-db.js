import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/trade-journal-db.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./trade-journal-db.legacy.js');
  }
})();

export const initJournalSchema = loaded.initJournalSchema;
export const generateTradeId = loaded.generateTradeId;
export const insertJournalEntry = loaded.insertJournalEntry;
export const closeJournalEntry = loaded.closeJournalEntry;
export const getJournalEntryByTradeId = loaded.getJournalEntryByTradeId;
export const getLatestJournalEntryBySignalId = loaded.getLatestJournalEntryBySignalId;
export const getReviewByTradeId = loaded.getReviewByTradeId;
export const getTradeReviewInsight = loaded.getTradeReviewInsight;
export const ratioToPercent = loaded.ratioToPercent;
export const ensureAutoReview = loaded.ensureAutoReview;
export const getOpenJournalEntries = loaded.getOpenJournalEntries;
export const getJournalByDate = loaded.getJournalByDate;
export const insertRationale = loaded.insertRationale;
export const hireAnalystForSignal = loaded.hireAnalystForSignal;
export const evaluateAnalystContract = loaded.evaluateAnalystContract;
export const linkRationaleToTrade = loaded.linkRationaleToTrade;
export const insertReview = loaded.insertReview;
export const upsertDailyPerformance = loaded.upsertDailyPerformance;
export const getDailyPerformance = loaded.getDailyPerformance;
export const getWeeklyPerformance = loaded.getWeeklyPerformance;
export const logMonitorEvent = loaded.logMonitorEvent;
export const getApiFailureCount = loaded.getApiFailureCount;
export const getExecutionDelayStats = loaded.getExecutionDelayStats;
export const getUnresolvedIssues = loaded.getUnresolvedIssues;
export default loaded;
