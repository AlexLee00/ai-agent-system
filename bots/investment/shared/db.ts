// @ts-nocheck
/**
 * shared/db.js — PostgreSQL investment 스키마 (Phase 4 마이그레이션)
 *
 * 위치: PostgreSQL jay DB, investment 스키마
 * 테이블: analysis, signals, trades, positions,
 *         strategy_pool, risk_log, asset_snapshot,
 *         runtime_config_suggestion_log, schema_migrations
 */

import {
  query,
  run,
  get,
  withTransaction,
  close as closeDbCore,
} from './db/core.ts';
import { initSchema } from './db/schema-init.ts';

export { query, run, get, withTransaction };

// ─── 스키마 초기화 ──────────────────────────────────────────────────

export { initSchema };

// ─── domain re-exports ──────────────────────────────────────────────
import { insertAnalysis, getRecentAnalysis } from './db/analysis.ts';
export { insertAnalysis, getRecentAnalysis };

import {
  insertSignal, getRecentSignalDuplicate, getRecentBlockedSignalByCode, insertSignalIfFresh,
  updateSignalStatus, updateSignalApproval, updateSignalAmount, updateSignalBlock,
  mergeSignalBlockMeta, getSignalById, getPendingSignals, getApprovedSignals,
} from './db/signals.ts';
export {
  insertSignal, getRecentSignalDuplicate, getRecentBlockedSignalByCode, insertSignalIfFresh,
  updateSignalStatus, updateSignalApproval, updateSignalAmount, updateSignalBlock,
  mergeSignalBlockMeta, getSignalById, getPendingSignals, getApprovedSignals,
};

import { insertTrade, getTradeHistory, getLatestTradeBySignalId, getSameDayTrade } from './db/trades.ts';
export { insertTrade, getTradeHistory, getLatestTradeBySignalId, getSameDayTrade };

import {
  upsertPosition, deletePositionsForExchangeScope, getPosition, getLivePosition,
  getPaperPosition, getAllPositions, getPaperPositions, getOpenPositions, deletePosition, getTodayPnl,
} from './db/positions.ts';
export {
  upsertPosition, deletePositionsForExchangeScope, getPosition, getLivePosition,
  getPaperPosition, getAllPositions, getPaperPositions, getOpenPositions, deletePosition, getTodayPnl,
};

import {
  insertScreeningHistory, getRecentScreeningSymbols, getRecentScreeningDynamicSymbols, getRecentScreeningMarkets,
} from './db/screening.ts';
export {
  insertScreeningHistory, getRecentScreeningSymbols, getRecentScreeningDynamicSymbols, getRecentScreeningMarkets,
};

import {
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  getLatestVectorbtBacktestForSymbol, getLatestMarketRegimeSnapshot,
} from './db/strategy.ts';
export {
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  getLatestVectorbtBacktestForSymbol, getLatestMarketRegimeSnapshot,
};

import {
  getPositionStrategyProfile, getActivePositionStrategyProfiles, upsertPositionStrategyProfile,
  updatePositionStrategyProfileState, closePositionStrategyProfile,
} from './db/position-profile.ts';
export {
  getPositionStrategyProfile, getActivePositionStrategyProfiles, upsertPositionStrategyProfile,
  updatePositionStrategyProfileState, closePositionStrategyProfile,
};

import {
  upsertAgentRoleProfile, upsertAgentRoleState, getActiveAgentRoleStates, getAgentRoleState,
} from './db/roles.ts';
export {
  upsertAgentRoleProfile, upsertAgentRoleState, getActiveAgentRoleStates, getAgentRoleState,
};

import {
  insertRiskLog, insertAssetSnapshot, getLatestEquity, getEquityHistory, insertMarketRegimeSnapshot,
} from './db/risk.ts';
export {
  insertRiskLog, insertAssetSnapshot, getLatestEquity, getEquityHistory, insertMarketRegimeSnapshot,
};

import {
  insertRuntimeConfigSuggestionLog, getRecentRuntimeConfigSuggestionLogs,
  getRuntimeConfigSuggestionLogById, updateRuntimeConfigSuggestionLogReview,
} from './db/runtime-config.ts';
export {
  insertRuntimeConfigSuggestionLog, getRecentRuntimeConfigSuggestionLogs,
  getRuntimeConfigSuggestionLogById, updateRuntimeConfigSuggestionLogReview,
};

import {
  insertLifecycleEvent, getLifecycleEventsForScope, getLifecyclePhaseCoverage,
  insertCloseoutReview, updateCloseoutReview, getRecentCloseoutReviews,
  insertExternalEvidence, getRecentExternalEvidence,
  insertPositionSignalHistory, getRecentPositionSignalHistory,
} from './db/lifecycle.ts';
export {
  insertLifecycleEvent, getLifecycleEventsForScope, getLifecyclePhaseCoverage,
  insertCloseoutReview, updateCloseoutReview, getRecentCloseoutReviews,
  insertExternalEvidence, getRecentExternalEvidence,
  insertPositionSignalHistory, getRecentPositionSignalHistory,
};

import {
  fetchPendingPosttradeKnowledgeEvents, markPosttradeKnowledgeEventProcessed,
  insertFeedbackToActionMap, recordFeedbackToActionMap, getRecentFeedbackToActionMap,
  upsertPosttradeSkill, getRecentPosttradeSkills, cleanupPosttradeSmokeArtifacts,
} from './db/posttrade.ts';
export {
  fetchPendingPosttradeKnowledgeEvents, markPosttradeKnowledgeEventProcessed,
  insertFeedbackToActionMap, recordFeedbackToActionMap, getRecentFeedbackToActionMap,
  upsertPosttradeSkill, getRecentPosttradeSkills, cleanupPosttradeSmokeArtifacts,
};

export function close() {
  return closeDbCore();
}

export default {
  query, run, get, withTransaction, initSchema,
  insertAnalysis, getRecentAnalysis,
  insertSignal, getRecentSignalDuplicate, getRecentBlockedSignalByCode, insertSignalIfFresh,
  updateSignalStatus, updateSignalApproval, updateSignalAmount, updateSignalBlock,
  mergeSignalBlockMeta, getSignalById, getPendingSignals, getApprovedSignals,
  insertTrade, getTradeHistory, getLatestTradeBySignalId, getSameDayTrade,
  upsertPosition, deletePositionsForExchangeScope, getPosition, getLivePosition,
  getPaperPosition, getAllPositions, getPaperPositions, getOpenPositions, deletePosition,
  getTodayPnl,
  insertScreeningHistory,
  getRecentScreeningSymbols, getRecentScreeningDynamicSymbols, getRecentScreeningMarkets,
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  getLatestVectorbtBacktestForSymbol, getLatestMarketRegimeSnapshot,
  getPositionStrategyProfile, getActivePositionStrategyProfiles, upsertPositionStrategyProfile, updatePositionStrategyProfileState, closePositionStrategyProfile,
  upsertAgentRoleProfile, upsertAgentRoleState, getActiveAgentRoleStates, getAgentRoleState,
  insertRiskLog,
  insertAssetSnapshot, getLatestEquity, getEquityHistory,
  insertMarketRegimeSnapshot,
  insertRuntimeConfigSuggestionLog, getRecentRuntimeConfigSuggestionLogs,
  getRuntimeConfigSuggestionLogById, updateRuntimeConfigSuggestionLogReview,
  insertLifecycleEvent, getLifecycleEventsForScope, getLifecyclePhaseCoverage,
  insertCloseoutReview, updateCloseoutReview, getRecentCloseoutReviews,
  insertExternalEvidence, getRecentExternalEvidence,
  insertPositionSignalHistory, getRecentPositionSignalHistory,
  fetchPendingPosttradeKnowledgeEvents, markPosttradeKnowledgeEventProcessed,
  insertFeedbackToActionMap, recordFeedbackToActionMap, getRecentFeedbackToActionMap,
  upsertPosttradeSkill, getRecentPosttradeSkills, cleanupPosttradeSmokeArtifacts,
  close,
};
