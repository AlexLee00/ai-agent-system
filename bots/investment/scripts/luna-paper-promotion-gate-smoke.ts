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
    winRate: 55,
    gateStatus: 'pass',
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
assert.equal(report.requiredApproval, 'explicit_master_live_promotion_approval');
assert.equal(report.summary.promotionCandidates, 1);
assert.equal(report.readinessSummary.promotionRequiresExplicitMasterApproval, true);
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
assert.equal(runtime.limitSemantics, LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS);
assert.equal(inserted.length, 0);

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
    applyRows: applied.length,
    liveMutation: runtime.liveMutation,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-paper-promotion-gate-smoke ok');
}
