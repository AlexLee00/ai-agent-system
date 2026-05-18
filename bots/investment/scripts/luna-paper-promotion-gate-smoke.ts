#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLunaPaperPromotionRowsSql,
  buildLunaPaperPromotionGateReport,
  evaluateLunaPaperPromotionHistory,
  LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS,
  normalizeLunaPaperPromotionLoaderConfig,
} from '../shared/luna-paper-promotion-gate.ts';
import { runLunaPaperPromotionGateShadow } from './runtime-luna-paper-promotion-gate.ts';

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const passEvidence = {
  bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
  weightVector: { noLookaheadOk: true },
  promotionBacktestQuality: {
    fresh: true,
    healthy: true,
    sharpe: 1.5,
    maxDrawdown: 12,
    winRate: 55,
    totalTrades: 42,
    minPeriodTrades: 12,
    gateStatus: 'pass',
    wouldBlock: false,
    blockReasons: [],
    fallbackUsed: false,
    vectorbtEnabled: true,
  },
  promotionStrategyQuality: {
    enhancementStatus: 'shadow_ready',
    hyperoptStatus: 'not_required',
    maxDrawdownGuard: 'observe',
    indicatorScore: 0.75,
  },
};
const hardHoldEvidence = {
  ...passEvidence,
  bottleneckAvoidance: { present: true, hardHold: true, preventedOrder: false, action: 'quarantine_candidate_shadow' },
};
const preventedOrderEvidence = {
  ...passEvidence,
  bottleneckAvoidance: { present: true, hardHold: false, preventedOrder: true, action: 'prevent_order_shadow' },
};
const strategyQualityEvidence = {
  ...passEvidence,
  bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
  weightVector: { noLookaheadOk: true },
  promotionStrategyQuality: {
    enhancementStatus: 'shadow_review',
    hyperoptStatus: 'planned',
    maxDrawdownGuard: 'block_live_forward',
    indicatorScore: 0.2,
    reasons: ['max_drawdown_gt_20pct'],
  },
};
const unhealthyBacktestEvidence = {
  ...passEvidence,
  promotionBacktestQuality: {
    fresh: true,
    healthy: false,
    sharpe: -4.2,
    maxDrawdown: 39.6,
    winRate: 37.1,
    totalTrades: 36,
    minPeriodTrades: 10,
    gateStatus: 'would_block_unhealthy',
    wouldBlock: true,
    blockReasons: ['sharpe_negative(-4.20)', 'drawdown_high(39.6%)'],
    fallbackUsed: false,
    vectorbtEnabled: true,
  },
};
const lowTradeBacktestEvidence = {
  ...passEvidence,
  promotionBacktestQuality: {
    fresh: true,
    healthy: true,
    sharpe: 1.2,
    maxDrawdown: 8,
    winRate: 58,
    totalTrades: 7,
    minPeriodTrades: 3,
    gateStatus: 'pass',
    wouldBlock: false,
    blockReasons: [],
    fallbackUsed: false,
    vectorbtEnabled: true,
  },
};

const passHistory = [
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.74, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(1) },
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(61) },
];
const pass = evaluateLunaPaperPromotionHistory(passHistory, {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(pass.promotionCandidate, true);
assert.equal(pass.decision, 'shadow_promotion_candidate_ready');
assert.equal(pass.consecutivePasses, 3);
assert.equal(pass.cyclesRemaining, 0);
assert.equal(pass.consecutivePassesRemaining, 0);
assert.equal(pass.confidenceGap, 0);
assert.equal(pass.promotionBlockerClass, 'ready_for_master_review');
assert.equal(pass.nextRequiredEvidence[0].type, 'master_review');
assert.equal(pass.evidence.promotionRequiresExplicitMasterApproval, true);
assert.equal(pass.liveMutation, false);

const blocked = evaluateLunaPaperPromotionHistory([
  { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.55, status: 'no_action', shadow_only: true, evidence: hardHoldEvidence, observed_at: iso(1) },
  ...passHistory.slice(1).map((row) => ({ ...row, symbol: 'RISK/USDT' })),
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(blocked.promotionCandidate, false);
assert.equal(blocked.decision, 'shadow_promotion_observe');
assert.ok(blocked.blockReasons.includes('candidate_bottleneck_hard_hold_seen'));
assert.equal(blocked.consecutivePasses, 0);
assert.equal(blocked.promotionBlockerClass, 'risk_quality');
assert.ok(blocked.nextRequiredEvidence.some((item) => item.type === 'risk_quality'));

const strategyBlocked = evaluateLunaPaperPromotionHistory([
  { symbol: 'SQ/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.76, status: 'planned', shadow_only: true, evidence: strategyQualityEvidence, observed_at: iso(1) },
  { symbol: 'SQ/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
  { symbol: 'SQ/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(61) },
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(strategyBlocked.promotionCandidate, false);
assert.ok(strategyBlocked.blockReasons.includes('strategy_quality_block_live_forward_seen'));
assert.ok(strategyBlocked.blockReasons.includes('strategy_hyperopt_planned_seen'));
assert.equal(strategyBlocked.promotionBlockerClass, 'risk_quality');

const recoveredStrategyQuality = evaluateLunaPaperPromotionHistory([
  { symbol: 'RECOVER/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.76, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(1) },
  { symbol: 'RECOVER/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
  { symbol: 'RECOVER/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(61) },
  { symbol: 'RECOVER/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.2, status: 'no_action', shadow_only: true, evidence: strategyQualityEvidence, observed_at: iso(91) },
  { symbol: 'RECOVER/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.1, status: 'no_action', shadow_only: true, evidence: passEvidence, observed_at: iso(121) },
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(recoveredStrategyQuality.promotionCandidate, true, 'latest recovered BUY passes should not be blocked by older strategy-review rows');
assert.equal(recoveredStrategyQuality.avgConfidence >= 0.7, true, 'promotion confidence should be based on BUY pass rows once they exist');
assert.equal(recoveredStrategyQuality.evidence.avgConfidenceSource, 'paper_buy_pass_rows');

const recoveredBottleneckAvoidance = evaluateLunaPaperPromotionHistory([
  { symbol: 'RECOVER-BN/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.76, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(1) },
  { symbol: 'RECOVER-BN/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
  { symbol: 'RECOVER-BN/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(61) },
  { symbol: 'RECOVER-BN/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.2, status: 'no_action', shadow_only: true, evidence: preventedOrderEvidence, observed_at: iso(91) },
  { symbol: 'RECOVER-BN/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.1, status: 'no_action', shadow_only: true, evidence: hardHoldEvidence, observed_at: iso(121) },
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(recoveredBottleneckAvoidance.promotionCandidate, true, 'latest clean BUY passes should not be blocked by older bottleneck avoidance rows');
assert.equal(recoveredBottleneckAvoidance.evidence.hardHoldCount, 1);
assert.equal(recoveredBottleneckAvoidance.evidence.preventedOrderCount, 1);
assert.equal(recoveredBottleneckAvoidance.evidence.latestBottleneckHardHold, false);
assert.equal(recoveredBottleneckAvoidance.evidence.latestBottleneckPreventedOrder, false);

const missingQuality = evaluateLunaPaperPromotionHistory(passHistory.map((row) => ({
  ...row,
  symbol: 'MISSING/USDT',
  evidence: {
    bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
    weightVector: { noLookaheadOk: true },
    promotionBacktestQuality: {
      fresh: true,
      healthy: true,
      sharpe: 1.5,
      gateStatus: 'pass',
      fallbackUsed: false,
      vectorbtEnabled: false,
    },
  },
})), {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(missingQuality.promotionCandidate, false);
assert.ok(missingQuality.blockReasons.includes('non_vectorbt_backtest_seen'));
assert.ok(missingQuality.blockReasons.includes('missing_strategy_quality_seen'));
assert.equal(missingQuality.promotionBlockerClass, 'strategy_or_backtest_quality');

const unhealthyBacktestBlocked = evaluateLunaPaperPromotionHistory(passHistory.map((row) => ({
  ...row,
  symbol: 'NEG/USDT',
  evidence: unhealthyBacktestEvidence,
})), {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(unhealthyBacktestBlocked.promotionCandidate, false);
assert.equal(unhealthyBacktestBlocked.decision, 'shadow_promotion_blocked');
assert.equal(unhealthyBacktestBlocked.passCount, 0);
assert.ok(unhealthyBacktestBlocked.blockReasons.includes('unhealthy_backtest_seen'));
assert.ok(unhealthyBacktestBlocked.blockReasons.includes('backtest_would_block_seen'));
assert.ok(unhealthyBacktestBlocked.blockReasons.includes('backtest_gate_not_pass_seen'));
assert.ok(unhealthyBacktestBlocked.blockReasons.includes('sharpe_below_promotion_floor_seen'));
assert.ok(unhealthyBacktestBlocked.blockReasons.includes('drawdown_above_promotion_ceiling_seen'));
assert.equal(unhealthyBacktestBlocked.promotionBlockerClass, 'strategy_or_backtest_quality');
assert.equal(unhealthyBacktestBlocked.evidence.recent[0].pass, false);

const lowTradeBacktestBlocked = evaluateLunaPaperPromotionHistory(passHistory.map((row) => ({
  ...row,
  symbol: 'LOW-SAMPLE/USDT',
  evidence: lowTradeBacktestEvidence,
})), {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(lowTradeBacktestBlocked.promotionCandidate, false);
assert.equal(lowTradeBacktestBlocked.passCount, 0);
assert.ok(lowTradeBacktestBlocked.blockReasons.includes('backtest_low_trade_sample_seen'));
assert.equal(lowTradeBacktestBlocked.promotionBlockerClass, 'strategy_or_backtest_quality');

const onePassAway = evaluateLunaPaperPromotionHistory([
  { symbol: 'NEAR/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.75, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(1) },
  { symbol: 'NEAR/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(onePassAway.promotionCandidate, false);
assert.equal(onePassAway.promotionBlockerClass, 'paper_cycles');
assert.equal(onePassAway.cyclesRemaining, 1);
assert.equal(onePassAway.consecutivePassesRemaining, 1);
assert.ok(onePassAway.readinessScore >= 0.55);
assert.ok(onePassAway.nextRequiredEvidence.some((item) => item.type === 'paper_cycles'));

const report = buildLunaPaperPromotionGateReport([...passHistory, ...passHistory.map((row) => ({ ...row, symbol: 'LOW/USDT', confidence: 0.4 }))], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(report.promotionReady, false);
assert.equal(report.promotionCandidateReady, true);
assert.equal(report.readyForMasterReview, true);
assert.equal(report.masterApprovalRequired, true);
assert.equal(report.requiredApproval, 'explicit_master_live_promotion_approval');
assert.equal(report.summary.promotionCandidates, 1);
assert.equal(report.summary.approvalBlockedCandidates, 1);
assert.equal(report.readinessSummary.promotionCandidateReady, true);
assert.equal(report.readinessSummary.approvalBlockedCandidates, 1);
assert.equal(report.readinessSummary.promotionRequiresExplicitMasterApproval, true);
assert.equal(report.readinessSummary.nextApprovalAction, 'run_explicit_master_review_before_active_entry_trigger_materialization');
assert.ok(Array.isArray(report.readinessSummary.topBlockers));
assert.ok(Array.isArray(report.readinessSummary.nextPaperCycleTargets));

const inserted = [];
const runtime = await runLunaPaperPromotionGateShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
}, {
  insertGate: async (row) => inserted.push(row),
});
assert.equal(runtime.ok, true);
assert.equal(runtime.writeMode, 'plan-only');
assert.equal(runtime.summary.promotionCandidates, 1);
assert.equal(runtime.summary.approvalBlockedCandidates, 1);
assert.equal(runtime.promotionCandidateReady, true);
assert.equal(runtime.readyForMasterReview, true);
assert.equal(runtime.limitSemantics, LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS);
assert.equal(inserted.length, 0);

const activeFilteredRuntime = await runLunaPaperPromotionGateShadow({
  json: true,
  dryRun: true,
  apply: false,
}, {
  loadRows: async () => [
    ...passHistory,
    ...passHistory.map((row) => ({ ...row, symbol: 'OLD/USDT' })),
  ],
  loadActiveSymbolKeys: async () => new Set(['PASS/USDT|crypto']),
});
assert.equal(activeFilteredRuntime.summary.totalSymbols, 1);
assert.equal(activeFilteredRuntime.summary.promotionCandidates, 1);
assert.equal(activeFilteredRuntime.activePromotionFilter.enabled, true);
assert.equal(activeFilteredRuntime.activePromotionFilter.excludedInactiveRowCount, 3);

const loaderConfig = normalizeLunaPaperPromotionLoaderConfig({ hours: 168, limit: 120 });
assert.equal(loaderConfig.hours, 168);
assert.equal(loaderConfig.perSymbolHistoryLimit, 120);

const loaderSql = buildLunaPaperPromotionRowsSql();
assert.match(loaderSql, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY pts\.symbol, pts\.market/s);
assert.match(loaderSql, /WHERE pr\.symbol_history_rank <= \$2/);
assert.doesNotMatch(loaderSql, /ORDER BY pr\.symbol, pr\.market, pr\.observed_at DESC\s+LIMIT \$2/s);

await assert.rejects(
  () => runLunaPaperPromotionGateShadow({
    json: true,
    fixture: true,
    dryRun: true,
    apply: true,
    confirm: 'luna-paper-promotion-gate-shadow',
  }, {
    ensureSchema: async () => null,
    insertGate: async (row) => inserted.push(row),
  }),
  /cannot combine --apply with --dry-run/,
);
assert.equal(inserted.length, 0);

const applied = [];
const applyRuntime = await runLunaPaperPromotionGateShadow({
  json: true,
  fixture: true,
  apply: true,
  confirm: 'luna-paper-promotion-gate-shadow',
}, {
  ensureSchema: async () => null,
  insertGate: async (row) => applied.push(row),
});
assert.equal(applyRuntime.writeMode, 'promotion-gate-shadow-apply');
assert.equal(applied.length, applyRuntime.items.length);
assert.equal(applyRuntime.promotionReady, false);

const root = path.resolve(import.meta.dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
assert.match(bootstrap, /luna_paper_promotion_gate_shadow/);

const payload = {
  ok: true,
  smoke: 'luna-paper-promotion-gate',
  pass: {
    decision: pass.decision,
    consecutivePasses: pass.consecutivePasses,
    promotionCandidate: pass.promotionCandidate,
    readinessScore: pass.readinessScore,
  },
  blocked: {
    decision: blocked.decision,
    promotionBlockerClass: blocked.promotionBlockerClass,
    reasons: blocked.blockReasons,
  },
  strategyBlocked: {
    decision: strategyBlocked.decision,
    reasons: strategyBlocked.blockReasons,
  },
  missingQuality: {
    decision: missingQuality.decision,
    reasons: missingQuality.blockReasons,
  },
  lowTradeBacktestBlocked: {
    decision: lowTradeBacktestBlocked.decision,
    reasons: lowTradeBacktestBlocked.blockReasons,
  },
  onePassAway: {
    cyclesRemaining: onePassAway.cyclesRemaining,
    consecutivePassesRemaining: onePassAway.consecutivePassesRemaining,
    readinessScore: onePassAway.readinessScore,
  },
  runtime: {
    writeMode: runtime.writeMode,
    limitSemantics: runtime.limitSemantics,
    promotionCandidates: runtime.summary.promotionCandidates,
    nearReady: runtime.summary.nearReady,
    applyDryRunRejected: true,
    activeFilteredSymbols: activeFilteredRuntime.summary.totalSymbols,
    applyRows: applied.length,
    liveMutation: runtime.liveMutation,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-paper-promotion-gate-smoke ok');
}
