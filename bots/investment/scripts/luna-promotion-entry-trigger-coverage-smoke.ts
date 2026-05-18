#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPromotionEntryTriggerCoverageReport } from '../shared/luna-promotion-entry-trigger-coverage.ts';
import { runLunaPromotionEntryTriggerCoverage } from './runtime-luna-promotion-entry-trigger-coverage.ts';

const now = new Date('2026-05-17T12:00:00.000Z');

const promotionRows = [
  {
    symbol: 'AIGENSYN/USDT',
    market: 'crypto',
    exchange: 'binance',
    decision: 'shadow_promotion_candidate_ready',
    promotion_candidate: true,
    cycle_count: 43,
    pass_count: 3,
    consecutive_passes: 3,
    avg_confidence: 0.7405,
    observed_at: '2026-05-17T11:50:00.000Z',
  },
  {
    symbol: 'ZEC/USDT',
    market: 'crypto',
    exchange: 'binance',
    decision: 'shadow_promotion_candidate_ready',
    promotion_candidate: true,
    cycle_count: 9,
    pass_count: 3,
    consecutive_passes: 3,
    avg_confidence: 0.66,
    observed_at: '2026-05-17T11:49:00.000Z',
  },
  {
    symbol: 'HOLD/USDT',
    market: 'crypto',
    exchange: 'binance',
    decision: 'shadow_promotion_observe',
    promotion_candidate: false,
    avg_confidence: 0.4,
    observed_at: '2026-05-17T11:48:00.000Z',
  },
];

const allMarketPromotionRows = [
  ...promotionRows,
  {
    symbol: 'MSFT',
    market: 'overseas',
    exchange: 'kis_overseas',
    decision: 'shadow_promotion_candidate_ready',
    promotion_candidate: true,
    cycle_count: 70,
    pass_count: 70,
    consecutive_passes: 70,
    avg_confidence: 0.7099,
    observed_at: '2026-05-17T11:47:00.000Z',
  },
];

const activeTriggerRows = [
  {
    id: 'trigger-zec',
    symbol: 'ZEC/USDT',
    exchange: 'binance',
    trigger_type: 'mtf_alignment',
    trigger_state: 'waiting',
    confidence: 0.66,
    predictive_score: 0.7,
    expires_at: '2026-05-17T13:00:00.000Z',
    created_at: '2026-05-17T11:00:00.000Z',
    updated_at: '2026-05-17T11:30:00.000Z',
  },
];

const latestTriggerRows = [
  ...activeTriggerRows,
  {
    id: 'trigger-aigensyn-expired',
    symbol: 'AIGENSYN/USDT',
    exchange: 'binance',
    trigger_type: 'mtf_alignment',
    trigger_state: 'expired',
    confidence: 0.66,
    predictive_score: 0.81,
    expires_at: '2026-05-17T10:00:00.000Z',
    created_at: '2026-05-17T07:00:00.000Z',
    updated_at: '2026-05-17T10:00:00.000Z',
  },
];

const bridgeRows = [
  {
    id: 'promotion-entry-trigger-bridge:crypto:binance:AIGENSYN_USDT',
    symbol: 'AIGENSYN/USDT',
    market: 'crypto',
    exchange: 'binance',
    bridge_status: 'shadow_bridge_pending_approval',
    gap_reason: 'promotion_ready_active_entry_trigger_missing',
    promotion_observed_at: '2026-05-17T11:50:00.000Z',
    promotion_confidence: 0.7405,
    trigger_type: 'mtf_alignment',
    proposed_trigger_state: 'armed',
    approval_required: 'explicit_master_live_promotion_approval',
    shadow_only: true,
    live_mutation: false,
    entry_trigger_db_mutation: false,
    created_at: '2026-05-17T11:51:00.000Z',
    updated_at: '2026-05-17T11:51:00.000Z',
  },
];

const report = buildPromotionEntryTriggerCoverageReport({
  promotionRows,
  activeTriggerRows,
  latestTriggerRows,
  bridgeRows,
  now,
  hours: 168,
  market: 'crypto',
  exchange: 'binance',
});

assert.equal(report.ok, false);
assert.equal(report.summary.promotionCandidates, 2);
assert.equal(report.summary.coveredByActiveTrigger, 1);
assert.equal(report.summary.missingActiveTrigger, 1);
assert.equal(report.summary.stagedPendingMaterialization, 1);
assert.equal(report.summary.unstagedMissingActiveTrigger, 0);
assert.equal(report.rows.find((row) => row.symbol === 'ZEC/USDT')?.coverageStatus, 'covered_by_active_entry_trigger');
const missing = report.rows.find((row) => row.symbol === 'AIGENSYN/USDT');
assert.equal(missing?.coverageStatus, 'promotion_ready_staged_for_entry_trigger_materialization');
assert.equal(missing?.gapReason, 'promotion_ready_materialization_approval_required');
assert.equal(missing?.bridge?.pendingMaterialization, true);
assert.equal(missing?.bridgePreview?.liveMutationAllowed, false);

const runtime = await runLunaPromotionEntryTriggerCoverage({
  json: true,
  dryRun: true,
  market: 'crypto',
  exchange: 'binance',
  hours: 168,
  limit: 100,
}, {
  now,
  promotionRows,
  activeTriggerRows,
  latestTriggerRows,
  bridgeRows,
});

assert.equal(runtime.summary.missingActiveTrigger, 1);
assert.equal(runtime.summary.stagedPendingMaterialization, 1);
assert.equal(runtime.liveMutation, false);

const defaultRuntime = await runLunaPromotionEntryTriggerCoverage(undefined, {
  now,
  promotionRows: allMarketPromotionRows,
  activeTriggerRows,
  latestTriggerRows,
  bridgeRows,
});
assert.equal(defaultRuntime.market, 'all');
assert.equal(defaultRuntime.exchange, 'all');
assert.equal(defaultRuntime.summary.promotionCandidates, 3);
assert.equal(defaultRuntime.summary.unstagedMissingActiveTrigger, 1);
assert.equal(defaultRuntime.rows.some((row) => row.symbol === 'MSFT' && row.market === 'overseas'), true);

const applyBlocked = await runLunaPromotionEntryTriggerCoverage({ apply: true, json: true });
assert.equal(applyBlocked.ok, false);
assert.equal(applyBlocked.status, 'luna_promotion_entry_trigger_coverage_apply_blocked');
assert.equal(applyBlocked.liveMutation, false);

const payload = {
  smoke: 'luna-promotion-entry-trigger-coverage',
  ok: true,
  summary: report.summary,
  missingSymbol: missing?.symbol,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-promotion-entry-trigger-coverage-smoke ok');
}
