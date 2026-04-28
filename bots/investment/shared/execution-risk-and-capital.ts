// @ts-nocheck
/**
 * Execution risk/capital facade for Hephaestos.
 *
 * This keeps the executor imports narrow while the underlying risk approval
 * and capital manager modules remain independently owned.
 */

export { buildExecutionRiskApprovalGuard } from './risk-approval-execution-guard.ts';

export {
  preTradeCheck,
  calculatePositionSize,
  getAvailableBalance,
  getAvailableUSDT,
  getOpenPositions,
  getDailyPnL,
  getDailyTradeCount,
  checkCircuitBreaker,
  getCapitalConfig,
  formatDailyTradeLimitReason,
  getDynamicMinOrderAmount,
} from './capital-manager.ts';
