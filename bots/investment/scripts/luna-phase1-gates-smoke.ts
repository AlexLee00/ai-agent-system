#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import { get } from '../shared/db/core.ts';
import { buildPredictiveValidationEvidence } from '../shared/predictive-validation.ts';
import { evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import { runBuySafetyGuards } from '../team/hephaestos/execution-guards.ts';
import { buildFixtureBinanceTopVolumeUniverse } from '../shared/binance-top-volume-universe.ts';
import { evaluateActiveEntryTriggerQualityGate, loadActiveEntryTriggerQuality } from '../shared/entry-trigger-engine.ts';

const AUDIT_SMOKE_SYMBOL = `SMOKE-PHASE1-GATES-${process.pid}-${Date.now()}/USDT`;

function buildAuditSmokeUniverse() {
  const universe = buildFixtureBinanceTopVolumeUniverse();
  return {
    ...universe,
    symbols: [AUDIT_SMOKE_SYMBOL],
    ranks: { [AUDIT_SMOKE_SYMBOL]: 1 },
    rows: [],
  };
}

function baseDeps(overrides = {}) {
  const captured = [];
  const auditRecords = [];
  return {
    captured,
    auditRecords,
    input: {
      persistFailure: async (reason, payload) => captured.push({ reason, payload }),
      candidateBacktestAuditSink: async (sql, params) => auditRecords.push({ sql, params }),
      symbol: AUDIT_SMOKE_SYMBOL,
      action: ACTIONS.BUY,
      signalTradeMode: 'validation',
      signalConfidence: 0.92,
      capitalPolicy: { max_concurrent_positions: 3, max_daily_trades: 5 },
      signal: {
        symbol: AUDIT_SMOKE_SYMBOL,
        action: ACTIONS.BUY,
        exchange: 'binance',
        market: 'crypto',
        block_meta: {
          candidateBacktestStatus: {
            symbol: AUDIT_SMOKE_SYMBOL,
            market: 'crypto',
            fresh: false,
            healthy: false,
            sharpe: -0.5,
            would_block: true,
            block_reasons: ['negative_sharpe', 'stale_backtest'],
          },
        },
      },
      checkCircuitBreaker: async () => ({ triggered: false }),
      getOpenPositions: async () => [],
      getMaxPositionsOverflowPolicy: () => ({ enabled: false }),
      getDailyTradeCount: async () => 0,
      formatDailyTradeLimitReason: (current, limit) => `daily ${current}/${limit}`,
      notifyEnabled: false,
      binanceTopVolumeUniverse: buildAuditSmokeUniverse(),
      ...overrides,
    },
  };
}

function summarizeAuditRecord(record = {}) {
  const params = Array.isArray(record.params) ? record.params : [];
  const candidateSnapshot = JSON.parse(params[9] || '{}');
  return {
    symbol: params[0],
    market: params[1],
    decision: params[2],
    action: candidateSnapshot.action,
    mode: candidateSnapshot.gateMode,
    reason: params[6],
  };
}

async function loadPredictiveValidationCount(symbol) {
  const row = await get(
    'SELECT COUNT(*)::bigint AS count FROM investment.predictive_validation_log WHERE symbol = $1',
    [symbol],
  );
  const count = Number(row?.count);
  assert.ok(Number.isSafeInteger(count) && count >= 0, 'predictive validation count must be readable');
  return count;
}

const predictiveValidationCountBefore = await loadPredictiveValidationCount(AUDIT_SMOKE_SYMBOL);
assert.equal(predictiveValidationCountBefore, 0, 'unique smoke symbol must start without audit rows');

const staleShadow = evaluateCandidateBacktestStatus(
  { fresh: false, healthy: true, block_reasons: ['stale_backtest'] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow' },
);
assert.equal(staleShadow.wouldBlock, true);
assert.equal(staleShadow.blocked, false);

const staleEnforce = evaluateCandidateBacktestStatus(
  { fresh: false, healthy: true, block_reasons: ['stale_backtest'] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'enforce' },
);
assert.equal(staleEnforce.wouldBlock, true);
assert.equal(staleEnforce.blocked, true);

const drawdownEnforce = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, max_drawdown: 42, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'enforce', LUNA_CANDIDATE_BACKTEST_MAX_DRAWDOWN: '30' },
);
assert.equal(drawdownEnforce.wouldBlock, true);
assert.equal(drawdownEnforce.blocked, true);
assert.equal(drawdownEnforce.reason, 'candidate_backtest_drawdown_high');

const dsrGateOff = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, sharpe_oos_deflated: 1.1, max_drawdown: 10, dsr: 0.42, total_trades_oos: 45, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow' },
);
assert.equal(dsrGateOff.wouldBlock, false, 'DSR gate must be disabled by default');

const dsrGateLow = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, sharpe_oos_deflated: 1.1, max_drawdown: 10, dsr: 0.42, total_trades_oos: 45, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow', LUNA_DSR_GATE_ENABLED: 'true' },
);
assert.equal(dsrGateLow.wouldBlock, true);
assert.equal(dsrGateLow.reason, 'candidate_backtest_dsr_low');
assert.ok(dsrGateLow.reasons.some((reason) => reason.startsWith('candidate_backtest_dsr_low')));

const dsrGateBlankEnv = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, sharpe_oos_deflated: 1.1, max_drawdown: 10, dsr: 0.42, total_trades_oos: 45, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow', LUNA_DSR_GATE_ENABLED: 'true', LUNA_DSR_MIN: '', LUNA_DSR_MIN_TRADES: '' },
);
assert.equal(dsrGateBlankEnv.wouldBlock, true);
assert.equal(dsrGateBlankEnv.reason, 'candidate_backtest_dsr_low');

const dsrGateSmallSample = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, sharpe_oos_deflated: 1.1, max_drawdown: 10, dsr: 0.95, total_trades_oos: 15, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow', LUNA_DSR_GATE_ENABLED: 'true' },
);
assert.equal(dsrGateSmallSample.wouldBlock, true);
assert.equal(dsrGateSmallSample.reason, 'candidate_backtest_insufficient_trades');

const dsrNullBlocked = evaluateCandidateBacktestStatus(
  { fresh: true, healthy: true, sharpe_oos_deflated: 1.1, max_drawdown: 10, dsr: null, total_trades_oos: 15, block_reasons: [] },
  { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow', LUNA_DSR_GATE_ENABLED: 'true' },
);
assert.equal(dsrNullBlocked.wouldBlock, true, 'enabled DSR gate must fail closed when DSR is missing');
assert.equal(dsrNullBlocked.reason, 'candidate_backtest_dsr_missing');

const psrNotifyHardBlock = evaluateActiveEntryTriggerQualityGate({ symbol: 'BTC/USDT' }, {
  symbol: 'BTC/USDT',
  backtest: {
    fresh: true,
    healthy: true,
    sharpeOosDeflated: 1.1,
    maxDrawdown: 10,
    psr: 0.31,
    lastBacktestAt: new Date().toISOString(),
    blockReasons: [],
  },
  predictive: { decision: 'pass', score: 0.8 },
}, {
  activeQualityGateMode: 'notify',
  flags: { shouldAllowLiveEntryFire: () => true },
  env: { LUNA_PSR_GATE_ENABLED: 'true', LUNA_PSR_MIN: '0.5' },
});
assert.equal(psrNotifyHardBlock.ok, false, 'PSR gate failure must block live entry even in notify mode');
assert.equal(psrNotifyHardBlock.hardBlock, true);
assert.equal(psrNotifyHardBlock.hardBlockReason, 'candidate_backtest_psr_gate');

const psrMissingNotifyHardBlock = evaluateActiveEntryTriggerQualityGate({ symbol: 'BTC/USDT' }, {
  symbol: 'BTC/USDT',
  backtest: {
    fresh: true,
    healthy: true,
    sharpeOosDeflated: 1.1,
    maxDrawdown: 10,
    psr: null,
    lastBacktestAt: new Date().toISOString(),
    blockReasons: [],
  },
  predictive: { decision: 'pass', score: 0.8 },
}, {
  activeQualityGateMode: 'notify',
  flags: { shouldAllowLiveEntryFire: () => true },
  env: { LUNA_PSR_GATE_ENABLED: 'true', LUNA_PSR_MIN: '0.5' },
});
assert.equal(psrMissingNotifyHardBlock.ok, false, 'missing PSR must fail closed for live entry');
assert.equal(psrMissingNotifyHardBlock.hardBlockReason, 'candidate_backtest_psr_gate');

const pboQualityMap = await loadActiveEntryTriggerQuality(['PBO/USDT'], {
  market: 'crypto',
  env: { LUNA_PBO_GATE_ENABLED: 'true', LUNA_PBO_MAX: '0.3' },
  queryFn: async (sql) => String(sql).includes('candidate_backtest_status')
    ? [{
        symbol: 'PBO/USDT',
        market: 'crypto',
        fresh: true,
        healthy: true,
        last_backtest_at: new Date().toISOString(),
        gate_status: 'pass',
        would_block: false,
        block_reasons: [],
        pbo: 0.82,
      }]
    : [],
});
const pboQuality = pboQualityMap.get('PBO/USDT');
assert.equal(pboQuality?.backtest?.pbo, 0.82, 'stored PBO must reach the entry quality gate');
assert.ok(pboQuality?.backtest?.blockReasons?.some((reason) => String(reason).startsWith('candidate_backtest_pbo_high')));

const prevMode = process.env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE;
process.env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE = 'shadow';
const shadowDeps = baseDeps();
const shadowResult = await runBuySafetyGuards(shadowDeps.input);
assert.equal(shadowResult, null, 'shadow candidate backtest gate must not block live path');
assert.equal(shadowDeps.captured.length, 0);
assert.match(shadowDeps.auditRecords[0].sql, /INSERT INTO predictive_validation_log/);
assert.deepEqual(shadowDeps.auditRecords.map(summarizeAuditRecord), [{
  symbol: AUDIT_SMOKE_SYMBOL,
  market: 'crypto',
  decision: 'would_block_backtest_gate',
  action: ACTIONS.BUY,
  mode: 'shadow',
  reason: 'candidate_backtest_stale',
}]);

process.env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE = 'enforce';
const enforceDeps = baseDeps();
const enforceResult = await runBuySafetyGuards(enforceDeps.input);
assert.equal(enforceResult.success, false);
assert.equal(enforceDeps.captured[0].payload.code, 'candidate_backtest_gate_rejected');
assert.match(enforceDeps.auditRecords[0].sql, /INSERT INTO predictive_validation_log/);
assert.deepEqual(enforceDeps.auditRecords.map(summarizeAuditRecord), [{
  symbol: AUDIT_SMOKE_SYMBOL,
  market: 'crypto',
  decision: 'block_backtest_gate',
  action: ACTIONS.BUY,
  mode: 'enforce',
  reason: 'candidate_backtest_stale',
}]);

const failedAuditDeps = baseDeps({
  candidateBacktestAuditSink: async () => { throw new Error('smoke_audit_sink_failure'); },
});
const failedAuditResult = await runBuySafetyGuards(failedAuditDeps.input);
assert.equal(failedAuditResult.success, false, 'audit failure must not weaken enforce gate decision');
assert.equal(failedAuditDeps.captured[0].payload.code, 'candidate_backtest_gate_rejected');
if (prevMode == null) {
  delete process.env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE;
} else {
  process.env.LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE = prevMode;
}

const shadowPredictive = buildPredictiveValidationEvidence(
  { symbol: 'BTC/USDT', confidence: 0.8 },
  {},
  { requireComponents: true, threshold: 0.55 },
);
assert.equal(shadowPredictive.wouldBlock, true);
assert.notEqual(shadowPredictive.decision, 'block_coverage');

const enforcedPredictive = buildPredictiveValidationEvidence(
  { symbol: 'BTC/USDT', confidence: 0.8 },
  {},
  { requireComponents: true, hardeningEnforce: true, threshold: 0.55 },
);
assert.equal(enforcedPredictive.wouldBlock, true);
assert.match(enforcedPredictive.decision, /^block_/);

const predictiveValidationCountAfter = await loadPredictiveValidationCount(AUDIT_SMOKE_SYMBOL);
assert.equal(
  predictiveValidationCountAfter,
  predictiveValidationCountBefore,
  'phase1 gates smoke must not write predictive validation audit rows',
);

const payload = {
  ok: true,
  smoke: 'luna-phase1-gates',
  staleShadow,
  staleEnforce,
  dsrGateOff,
  dsrGateLow,
  dsrGateBlankEnv,
  dsrGateSmallSample,
  dsrNullBlocked,
  psrNotifyHardBlock,
  psrMissingNotifyHardBlock,
  enforceCode: enforceDeps.captured[0].payload.code,
  audit: {
    sink: 'in_memory_sql_storage',
    records: [...shadowDeps.auditRecords, ...enforceDeps.auditRecords].map(summarizeAuditRecord),
    targetTable: 'investment.predictive_validation_log',
    scopeSymbol: AUDIT_SMOKE_SYMBOL,
    beforeCount: predictiveValidationCountBefore,
    afterCount: predictiveValidationCountAfter,
    countInvariant: predictiveValidationCountAfter === predictiveValidationCountBefore,
    sinkFailurePreservedEnforceBlock: failedAuditResult.success === false,
  },
  predictive: {
    shadowDecision: shadowPredictive.decision,
    shadowWouldBlock: shadowPredictive.wouldBlock,
    enforcedDecision: enforcedPredictive.decision,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase1-gates-smoke ok');
}
