#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLifecycleExecutionReadiness,
  filterLifecycleCoverageProfiles,
  summarizeLifecyclePositionSync,
  summarizeLifecycleStageCoverage,
} from '../shared/position-lifecycle-operational-readiness.ts';

const activeProfiles = [
  { symbol: 'BTC/USDT', exchange: 'binance', trade_mode: 'normal' },
  { symbol: 'POET', exchange: 'kis_overseas', trade_mode: 'normal' },
];
const fullEvents = ['stage_1', 'stage_2', 'stage_3', 'stage_4', 'stage_5', 'stage_6', 'stage_7', 'stage_8']
  .map((stageId) => ({
    position_scope_key: 'binance:BTC/USDT:normal',
    symbol: 'BTC/USDT',
    exchange: 'binance',
    trade_mode: 'normal',
    stage_id: stageId,
  }));
const partialEvents = [
  { position_scope_key: 'kis_overseas:POET:normal', symbol: 'POET', exchange: 'kis_overseas', trade_mode: 'normal', stage_id: 'stage_5' },
];

const coverage = summarizeLifecycleStageCoverage({
  events: [...fullEvents, ...partialEvents],
  activeProfiles,
});
assert.equal(coverage.activePositions, 2);
assert.equal(coverage.rows.find((row) => row.symbol === 'BTC/USDT').missingStages.length, 0);
assert.equal(coverage.rows.find((row) => row.symbol === 'POET').missingStages.includes('stage_1'), true);
assert.equal(coverage.rows.find((row) => row.symbol === 'BTC/USDT').lateStageCoveragePct, 100);
assert.equal(coverage.rows.find((row) => row.symbol === 'POET').missingLateStages.includes('stage_4'), true);
assert.equal(coverage.missingByStage.stage_1, 1);
assert.equal(coverage.missingLateByStage.stage_4, 1);

const openPositionCoverage = summarizeLifecycleStageCoverage({
  events: [
    { position_scope_key: 'binance:PUMP/USDT:normal', symbol: 'PUMP/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_4' },
    { position_scope_key: 'binance:PUMP/USDT:normal', symbol: 'PUMP/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_5' },
  ],
  activeProfiles: [{ symbol: 'PUMP/USDT', exchange: 'binance', trade_mode: 'normal' }],
  actionableCandidates: [{ positionId: 'binance:PUMP/USDT:normal', action: 'ADJUST' }],
});
assert.equal(openPositionCoverage.lateStageCoveragePct, 40);
assert.equal(openPositionCoverage.applicableLateStageCoveragePct, 66.7);
assert.deepEqual(openPositionCoverage.rows[0].applicableLateStages, ['stage_4', 'stage_5', 'stage_6']);
assert.deepEqual(openPositionCoverage.rows[0].missingApplicableLateStages, ['stage_6']);

const openMonitorOnlyCoverage = summarizeLifecycleStageCoverage({
  events: [
    { position_scope_key: 'binance:MONITOR/USDT:normal', symbol: 'MONITOR/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_4' },
    { position_scope_key: 'binance:MONITOR/USDT:normal', symbol: 'MONITOR/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_5' },
  ],
  activeProfiles: [{ symbol: 'MONITOR/USDT', exchange: 'binance', trade_mode: 'normal', lifecycleStatus: 'holding' }],
  actionableCandidates: [],
});
assert.deepEqual(openMonitorOnlyCoverage.rows[0].applicableLateStages, ['stage_4', 'stage_5']);
assert.deepEqual(openMonitorOnlyCoverage.rows[0].nonApplicableLateStages, ['stage_6', 'stage_7', 'stage_8']);
assert.equal(openMonitorOnlyCoverage.rows[0].missingApplicableLateStages.length, 0);
assert.equal(openMonitorOnlyCoverage.applicableLateStageCoveragePct, 100);

const closedPositionCoverage = summarizeLifecycleStageCoverage({
  events: [
    { position_scope_key: 'binance:CLOSED/USDT:normal', symbol: 'CLOSED/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_4' },
    { position_scope_key: 'binance:CLOSED/USDT:normal', symbol: 'CLOSED/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_5' },
    { position_scope_key: 'binance:CLOSED/USDT:normal', symbol: 'CLOSED/USDT', exchange: 'binance', trade_mode: 'normal', stage_id: 'stage_6' },
  ],
  activeProfiles: [{ symbol: 'CLOSED/USDT', exchange: 'binance', trade_mode: 'normal', lifecycleStatus: 'closed' }],
  actionableCandidates: [],
});
assert.deepEqual(closedPositionCoverage.rows[0].applicableLateStages, ['stage_4', 'stage_5', 'stage_6', 'stage_7', 'stage_8']);
assert.deepEqual(closedPositionCoverage.rows[0].missingApplicableLateStages, ['stage_7', 'stage_8']);

const filteredProfiles = filterLifecycleCoverageProfiles({
  activeProfiles: [
    ...activeProfiles,
    { symbol: 'OLD/USDT', exchange: 'binance', trade_mode: 'normal' },
    { symbol: 'DUST/USDT', exchange: 'binance', trade_mode: 'normal' },
  ],
  livePositions: [
    { symbol: 'BTC/USDT', exchange: 'binance', trade_mode: 'normal', amount: 1, avg_price: 50000 },
    { symbol: 'DUST/USDT', exchange: 'binance', trade_mode: 'normal', amount: 1, avg_price: 0.5 },
  ],
  dustThresholdUsdt: 10,
});
assert.deepEqual(filteredProfiles.included.map((row) => row.symbol), ['BTC/USDT']);
assert.equal(filteredProfiles.meta.excludedOrphanProfileCount, 2);
assert.equal(filteredProfiles.meta.excludedDustProfileCount, 1);

const syncSummary = summarizeLifecyclePositionSync([
  { market: 'crypto', ok: true, mismatchCount: 0 },
  { market: 'overseas', ok: true, mismatchCount: 1 },
]);
assert.equal(syncSummary.ok, false);
assert.equal(syncSummary.mismatchCount, 1);

const readiness = buildLifecycleExecutionReadiness({
  flags: {
    mode: 'autonomous_l5',
    phaseD: { enabled: true },
    phaseE: { enabled: true },
    phaseF: { enabled: true },
    phaseG: { enabled: true },
    phaseH: { enabled: true },
  },
  runtimeReport: { decision: { metrics: { active: 2, adjustReady: 1, exitReady: 1 } } },
  dispatchPreview: { candidates: [{ symbol: 'BTC/USDT' }], guardReasonSummary: { blockedActionable: 0 } },
  signalRefresh: { ok: true, count: 2 },
  positionSyncSummary: { ok: true, mismatchCount: 0 },
  coverageSummary: coverage,
  requirePositionSync: true,
});
assert.equal(readiness.ok, true);
assert.equal(readiness.metrics.dispatchCandidates, 1);
assert.equal(readiness.metrics.lifecycleLateStageCoveragePct, coverage.lateStageCoveragePct);
assert.equal(readiness.metrics.lifecycleApplicableLateStageCoveragePct, coverage.applicableLateStageCoveragePct);

const blocked = buildLifecycleExecutionReadiness({
  flags: { mode: 'autonomous_l5', phaseD: { enabled: true }, phaseE: { enabled: true }, phaseF: { enabled: true }, phaseG: { enabled: true }, phaseH: { enabled: true } },
  signalRefresh: { ok: false },
  requirePositionSync: true,
});
assert.equal(blocked.ok, false);
assert.equal(blocked.blockers.includes('signal_refresh_failed'), true);
assert.equal(blocked.blockers.includes('position_sync_required_but_missing'), true);

console.log(JSON.stringify({ ok: true, coverage: coverage.coveragePct, readiness: readiness.status }, null, 2));
