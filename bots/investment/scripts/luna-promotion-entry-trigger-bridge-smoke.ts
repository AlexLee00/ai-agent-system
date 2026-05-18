#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPromotionEntryTriggerCoverageReport } from '../shared/luna-promotion-entry-trigger-coverage.ts';
import { buildPromotionEntryTriggerBridgePlan } from '../shared/luna-promotion-entry-trigger-bridge.ts';
import { runLunaPromotionEntryTriggerBridge } from './runtime-luna-promotion-entry-trigger-bridge.ts';

const now = new Date('2026-05-17T12:00:00.000Z');

const coverageReport = buildPromotionEntryTriggerCoverageReport({
  now,
  hours: 168,
  market: 'crypto',
  exchange: 'binance',
  promotionRows: [
    {
      symbol: 'AIGENSYN/USDT',
      market: 'crypto',
      exchange: 'binance',
      decision: 'shadow_promotion_candidate_ready',
      promotion_candidate: true,
      cycle_count: 4,
      pass_count: 4,
      consecutive_passes: 4,
      avg_confidence: 0.7409,
      observed_at: '2026-05-17T11:45:00.000Z',
    },
    {
      symbol: 'ZEC/USDT',
      market: 'crypto',
      exchange: 'binance',
      decision: 'shadow_promotion_candidate_ready',
      promotion_candidate: true,
      cycle_count: 4,
      pass_count: 4,
      consecutive_passes: 4,
      avg_confidence: 0.66,
      observed_at: '2026-05-17T11:44:00.000Z',
    },
  ],
  activeTriggerRows: [
    {
      id: 'active-zec',
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
  ],
  latestTriggerRows: [
    {
      id: 'expired-aigensyn',
      symbol: 'AIGENSYN/USDT',
      exchange: 'binance',
      trigger_type: 'mtf_alignment',
      trigger_state: 'expired',
      confidence: 0.66,
      predictive_score: 0.5938,
      expires_at: '2026-05-17T10:00:00.000Z',
      created_at: '2026-05-17T07:00:00.000Z',
      updated_at: '2026-05-17T10:00:00.000Z',
    },
  ],
});

const plan = buildPromotionEntryTriggerBridgePlan(coverageReport, { ttlMinutes: 180 });
assert.equal(plan.ok, false);
assert.equal(plan.summary.bridgePlanItems, 1);
assert.equal(plan.summary.liveMutation, false);
assert.equal(plan.summary.entryTriggerDbMutation, false);
assert.equal(plan.items[0].symbol, 'AIGENSYN/USDT');
assert.equal(plan.items[0].bridgeStatus, 'shadow_bridge_pending_approval');
assert.equal(plan.items[0].triggerPayload.waitingFor, 'luna_entry_trigger_fire_conditions');
assert.equal(plan.items[0].triggerPayload.triggerContext.hints.promotionReady, true);
assert.equal(plan.items[0].triggerPayload.triggerContext.hints.promotionPassCount, 4);
assert.equal(plan.items[0].triggerPayload.triggerContext.hints.promotionConsecutivePasses, 4);
assert.equal(plan.items[0].liveMutation, false);
assert.equal(plan.items[0].entryTriggerDbMutation, false);
assert.equal(plan.items[0].approvalRequired, 'autonomous_shadow_entry_trigger_materialization_confirm_token');

const applyBlocked = await runLunaPromotionEntryTriggerBridge({
  apply: true,
  dryRun: false,
  json: true,
  confirm: '',
}, { coverageReport });
assert.equal(applyBlocked.ok, false);
assert.equal(applyBlocked.status, 'luna_promotion_entry_trigger_bridge_apply_blocked');
assert.equal(applyBlocked.liveMutation, false);

const writes = [];
const runtime = await runLunaPromotionEntryTriggerBridge({
  apply: true,
  dryRun: false,
  json: true,
  confirm: 'luna-promotion-entry-trigger-bridge-shadow',
  ttlMinutes: 180,
}, {
  coverageReport,
  writePlan: async (nextPlan) => {
    writes.push(...nextPlan.items);
    return {
      ok: true,
      written: nextPlan.items.length,
      shadowDbMutation: nextPlan.items.length > 0,
      liveMutation: false,
      entryTriggerDbMutation: false,
    };
  },
});
assert.equal(runtime.status, 'luna_promotion_entry_trigger_bridge_shadow_written');
assert.equal(runtime.written, 1);
assert.equal(writes.length, 1);
assert.equal(runtime.liveMutation, false);
assert.equal(runtime.entryTriggerDbMutation, false);

const payload = {
  smoke: 'luna-promotion-entry-trigger-bridge',
  ok: true,
  bridgeItems: plan.summary.bridgePlanItems,
  written: runtime.written,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-promotion-entry-trigger-bridge-smoke ok');
}
