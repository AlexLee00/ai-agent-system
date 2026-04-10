import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/investment/shared/db.js'
);

const loaded = await (async () => {
  try {
    return require(runtimePath);
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    return import('./db.legacy.js');
  }
})();

export const query = loaded.query;
export const run = loaded.run;
export const get = loaded.get;
export const initSchema = loaded.initSchema;
export const insertAnalysis = loaded.insertAnalysis;
export const getRecentAnalysis = loaded.getRecentAnalysis;
export const insertSignal = loaded.insertSignal;
export const getRecentSignalDuplicate = loaded.getRecentSignalDuplicate;
export const getRecentBlockedSignalByCode = loaded.getRecentBlockedSignalByCode;
export const insertSignalIfFresh = loaded.insertSignalIfFresh;
export const updateSignalStatus = loaded.updateSignalStatus;
export const updateSignalAmount = loaded.updateSignalAmount;
export const updateSignalBlock = loaded.updateSignalBlock;
export const getSignalById = loaded.getSignalById;
export const getPendingSignals = loaded.getPendingSignals;
export const getApprovedSignals = loaded.getApprovedSignals;
export const insertTrade = loaded.insertTrade;
export const getTradeHistory = loaded.getTradeHistory;
export const getLatestTradeBySignalId = loaded.getLatestTradeBySignalId;
export const getSameDayTrade = loaded.getSameDayTrade;
export const upsertPosition = loaded.upsertPosition;
export const getPosition = loaded.getPosition;
export const getLivePosition = loaded.getLivePosition;
export const getPaperPosition = loaded.getPaperPosition;
export const getAllPositions = loaded.getAllPositions;
export const getPaperPositions = loaded.getPaperPositions;
export const getOpenPositions = loaded.getOpenPositions;
export const deletePosition = loaded.deletePosition;
export const getTodayPnl = loaded.getTodayPnl;
export const insertScreeningHistory = loaded.insertScreeningHistory;
export const getRecentScreeningSymbols = loaded.getRecentScreeningSymbols;
export const upsertStrategy = loaded.upsertStrategy;
export const getActiveStrategies = loaded.getActiveStrategies;
export const recordStrategyResult = loaded.recordStrategyResult;
export const insertRiskLog = loaded.insertRiskLog;
export const insertAssetSnapshot = loaded.insertAssetSnapshot;
export const getLatestEquity = loaded.getLatestEquity;
export const getEquityHistory = loaded.getEquityHistory;
export const insertRuntimeConfigSuggestionLog = loaded.insertRuntimeConfigSuggestionLog;
export const getRecentRuntimeConfigSuggestionLogs = loaded.getRecentRuntimeConfigSuggestionLogs;
export const getRuntimeConfigSuggestionLogById = loaded.getRuntimeConfigSuggestionLogById;
export const updateRuntimeConfigSuggestionLogReview = loaded.updateRuntimeConfigSuggestionLogReview;
export const close = loaded.close;
export default loaded;
