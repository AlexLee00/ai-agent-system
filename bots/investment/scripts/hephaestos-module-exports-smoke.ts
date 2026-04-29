#!/usr/bin/env node
// @ts-nocheck

import * as legacy from '../team/hephaestos.ts';
import * as pendingReconcile from '../team/hephaestos/pending-reconcile.ts';
import * as journalRepair from '../team/hephaestos/journal-repair.ts';
import * as pendingRetry from '../team/hephaestos/pending-retry.ts';
import { buildHephaestosExecutionContext } from '../team/hephaestos/execution-context.ts';
import {
  createPendingJournalRepairQueueProcessor,
  createPendingReconcileQueueProcessor,
} from '../team/hephaestos/pending-reconcile-runner.ts';
import { createPendingReconcileLedger } from '../team/hephaestos/pending-reconcile-ledger.ts';
import { createBinanceExecutionReconcileHandler } from '../team/hephaestos/binance-order-reconcile.ts';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';
import { createPortfolioPositionDelta } from '../team/hephaestos/portfolio-position-delta.ts';
import { createTelegramTradeAlerts } from '../team/hephaestos/telegram-trade-alerts.ts';
import { createMarketSignalPersistence } from '../team/hephaestos/market-signal-persistence.ts';
import { createSellExecutionResolution } from '../team/hephaestos/sell-execution-resolution.ts';
import { applyResponsibilityExecutionSizing } from '../team/hephaestos/execution-responsibility-sizing.ts';
import {
  createBuyProtectiveExitApplier,
  createStrategyExecutionStateSync,
} from '../team/hephaestos/execution-side-effects.ts';
import { createPaperPromotionPolicy } from '../team/hephaestos/paper-promotion.ts';
import { normalizePartialExitRatio } from '../team/hephaestos/partial-exit-policy.ts';
import { createProtectiveExitPolicy } from '../team/hephaestos/protective-exit.ts';
import { createUntrackedCapitalPolicy } from '../team/hephaestos/untracked-capital.ts';
import { createBtcPairDirectBuyPolicy } from '../team/hephaestos/btc-pair-direct-buy.ts';
import { createBuyReentryGuardPolicy } from '../team/hephaestos/buy-reentry-guards.ts';
import { createHephaestosExchangeHelpers } from '../team/hephaestos/exchange-helpers.ts';
import { createLivePositionReconcile } from '../team/hephaestos/live-position-reconcile.ts';
import { createMarketOrderExecution } from '../team/hephaestos/market-order-execution.ts';
import { createPendingSignalProcessing } from '../team/hephaestos/pending-signal-processing.ts';
import { createPendingReconcileContext } from '../team/hephaestos/pending-reconcile-context.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

const context = buildHephaestosExecutionContext({
  id: 'smoke-signal',
  symbol: 'BTC/USDT',
  action: 'BUY',
  amount_usdt: 42,
  trade_mode: 'validation',
}, {
  globalPaperMode: true,
  defaultTradeMode: 'normal',
});

const checks = [
  ['buildBinancePendingReconcilePayload', pendingReconcile.buildBinancePendingReconcilePayload === legacy.buildBinancePendingReconcilePayload],
  ['processBinancePendingReconcileQueue', pendingReconcile.processBinancePendingReconcileQueue === legacy.processBinancePendingReconcileQueue],
  ['processBinancePendingJournalRepairQueue', journalRepair.processBinancePendingJournalRepairQueue === legacy.processBinancePendingJournalRepairQueue],
  ['enqueueClientOrderPendingRetry', pendingRetry.enqueueClientOrderPendingRetry === legacy.enqueueClientOrderPendingRetry],
  ['pendingReconcileRunnerFactory', typeof createPendingReconcileQueueProcessor === 'function'],
  ['pendingJournalRepairRunnerFactory', typeof createPendingJournalRepairQueueProcessor === 'function'],
  ['pendingReconcileLedgerFactory', typeof createPendingReconcileLedger === 'function'],
  ['binanceExecutionReconcileHandlerFactory', typeof createBinanceExecutionReconcileHandler === 'function'],
  ['riskAndCapitalGatePolicyFactory', typeof createRiskAndCapitalGatePolicy === 'function'],
  ['portfolioPositionDeltaFactory', typeof createPortfolioPositionDelta === 'function'],
  ['telegramTradeAlertsFactory', typeof createTelegramTradeAlerts === 'function'],
  ['marketSignalPersistenceFactory', typeof createMarketSignalPersistence === 'function'],
  ['sellExecutionResolutionFactory', typeof createSellExecutionResolution === 'function'],
  ['responsibilitySizingPolicy', typeof applyResponsibilityExecutionSizing === 'function'],
  ['executionStateSyncFactory', typeof createStrategyExecutionStateSync === 'function'],
  ['buyProtectiveExitApplierFactory', typeof createBuyProtectiveExitApplier === 'function'],
  ['partialExitPolicy', normalizePartialExitRatio(0.333333) === 0.3333],
  ['paperPromotionPolicyFactory', typeof createPaperPromotionPolicy === 'function'],
  ['protectiveExitPolicyFactory', typeof createProtectiveExitPolicy === 'function'],
  ['untrackedCapitalPolicyFactory', typeof createUntrackedCapitalPolicy === 'function'],
  ['btcPairDirectBuyPolicyFactory', typeof createBtcPairDirectBuyPolicy === 'function'],
  ['buyReentryGuardPolicyFactory', typeof createBuyReentryGuardPolicy === 'function'],
  ['exchangeHelpersFactory', typeof createHephaestosExchangeHelpers === 'function'],
  ['livePositionReconcileFactory', typeof createLivePositionReconcile === 'function'],
  ['marketOrderExecutionFactory', typeof createMarketOrderExecution === 'function'],
  ['pendingSignalProcessingFactory', typeof createPendingSignalProcessing === 'function'],
  ['pendingReconcileContextFactory', typeof createPendingReconcileContext === 'function'],
  ['signalExecutorFactory', typeof createHephaestosSignalExecutor === 'function'],
  ['executionContext.amount', context.amountUsdt === 42],
  ['executionContext.base', context.base === 'BTC'],
  ['executionContext.tradeMode', context.signalTradeMode === 'validation'],
  ['executionContext.tag', context.tag === '[PAPER]'],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(`hephaestos submodule export mismatch: ${failed.map(([name]) => name).join(', ')}`);
}

const payload = {
  ok: true,
  smoke: 'hephaestos-module-exports',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos module export smoke passed');
}
