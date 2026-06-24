#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildFixtureBinanceTopVolumeUniverse } from '../shared/binance-top-volume-universe.ts';
import {
  LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM,
  runLunaPromotionEntryTriggerMaterialize,
} from './runtime-luna-promotion-entry-trigger-materialize.ts';

const now = new Date('2026-05-17T12:00:00.000Z');
const bridgeRows = [
  {
    id: 'bridge-btc',
    symbol: 'BTC/USDT',
    market: 'crypto',
    exchange: 'binance',
    bridge_status: 'shadow_bridge_pending_approval',
    gap_reason: 'promotion_ready_active_entry_trigger_missing',
    promotion_observed_at: '2026-05-17T11:45:00.000Z',
    promotion_confidence: 0.78,
    cycle_count: 8,
    pass_count: 7,
    consecutive_passes: 5,
    trigger_type: 'mtf_alignment',
    proposed_trigger_state: 'armed',
    ttl_minutes: 180,
    trigger_payload: {
      setupType: 'promotion_ready_shadow',
      triggerType: 'mtf_alignment',
      confidence: 0.78,
      predictiveScore: 0.74,
      waitingFor: 'explicit_master_live_promotion_approval',
      triggerContext: {
        source: 'smoke_promotion_gate',
        hints: {
          promotionReady: true,
          promotionPassCount: 7,
          promotionConsecutivePasses: 5,
          discoveryScore: 0.78,
        },
      },
      triggerMeta: { latestTrigger: { predictiveScore: 0.74 } },
    },
    coverage_snapshot: { activeTriggerCount: 0 },
  },
  {
    id: 'bridge-eth',
    symbol: 'ETH/USDT',
    market: 'crypto',
    exchange: 'binance',
    bridge_status: 'shadow_bridge_pending_approval',
    promotion_confidence: 0.73,
    trigger_type: 'mtf_alignment',
    proposed_trigger_state: 'armed',
    ttl_minutes: 180,
    trigger_payload: { confidence: 0.73, predictiveScore: 0.7 },
    coverage_snapshot: {},
  },
  {
    id: 'bridge-pepe',
    symbol: 'PEPE/USDT',
    market: 'crypto',
    exchange: 'binance',
    bridge_status: 'shadow_bridge_pending_approval',
    promotion_confidence: 0.72,
    trigger_type: 'mtf_alignment',
    proposed_trigger_state: 'armed',
    ttl_minutes: 180,
    trigger_payload: { confidence: 0.72, predictiveScore: 0.69 },
    coverage_snapshot: {},
  },
];

const universe = buildFixtureBinanceTopVolumeUniverse({ limit: 30 });
const domesticBridgeRow = {
  id: 'bridge-domestic',
  symbol: '037460',
  market: 'domestic',
  exchange: 'kis',
  bridge_status: 'shadow_bridge_pending_approval',
  promotion_confidence: 0.71,
  trigger_type: 'mtf_alignment',
  proposed_trigger_state: 'armed',
  ttl_minutes: 180,
  trigger_payload: { confidence: 0.71 },
  coverage_snapshot: {},
};

function deps(overrides = {}) {
  const inserted = [];
  const marked = [];
  return {
    inserted,
    marked,
    now,
    universe,
    bridgeRows,
    loadActiveEntryTrigger: async ({ symbol }) => (symbol === 'ETH/USDT' ? { id: 'active-eth' } : null),
    insertEntryTrigger: async (trigger) => {
      inserted.push(trigger);
      return { id: `inserted-${trigger.symbol.replace(/[^A-Z0-9]/g, '-').toLowerCase()}`, ...trigger };
    },
    markBridgeMaterialized: async (payload) => {
      marked.push(payload);
      return { rowCount: 1 };
    },
    ...overrides,
  };
}

const dryDeps = deps();
const dryRun = await runLunaPromotionEntryTriggerMaterialize({
  apply: false,
  dryRun: true,
  fixture: true,
  market: 'crypto',
  exchange: 'binance',
  ttlMinutes: 180,
}, dryDeps);
assert.equal(dryRun.ok, true);
assert.equal(dryRun.status, 'luna_promotion_entry_trigger_materialize_plan_attention');
assert.equal(dryRun.summary.pendingBridgeRows, 3);
assert.equal(dryRun.summary.eligibleDryRun, 1);
assert.equal(dryRun.summary.alreadyActive, 1);
assert.equal(dryRun.summary.blocked, 1);
assert.equal(dryRun.summary.materialized, 0);
assert.equal(dryDeps.inserted.length, 0);
assert.equal(dryDeps.marked.length, 0);
assert.equal(dryRun.items.find((item) => item.symbol === 'PEPE/USDT').top30Blocker, 'outside_binance_top_volume_universe');

const domesticDryRun = await runLunaPromotionEntryTriggerMaterialize({
  apply: false,
  dryRun: true,
  fixture: true,
  market: 'domestic',
  exchange: 'kis',
  ttlMinutes: 180,
}, deps({
  bridgeRows: [domesticBridgeRow],
  loadActiveEntryTrigger: async () => null,
}));
assert.equal(domesticDryRun.status, 'luna_promotion_entry_trigger_materialize_planned');
assert.equal(domesticDryRun.summary.eligibleDryRun, 1);
assert.equal(domesticDryRun.summary.blocked, 0);
assert.equal(domesticDryRun.items[0].binanceTop30Applicable, false);
assert.equal(domesticDryRun.items[0].top30Blocker, null);

const blockedApply = await runLunaPromotionEntryTriggerMaterialize({
  apply: true,
  dryRun: false,
  confirm: '',
}, deps());
assert.equal(blockedApply.ok, false);
assert.equal(blockedApply.status, 'luna_promotion_entry_trigger_materialize_apply_blocked');
assert.equal(blockedApply.liveMutation, false);

const applyDeps = deps();
const applied = await runLunaPromotionEntryTriggerMaterialize({
  apply: true,
  dryRun: false,
  fixture: true,
  confirm: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM,
  market: 'crypto',
  exchange: 'binance',
  ttlMinutes: 180,
}, applyDeps);
assert.equal(applied.status, 'luna_promotion_entry_trigger_materialize_partial');
assert.equal(applied.ok, false);
assert.equal(applied.summary.materialized, 1);
assert.equal(applied.summary.alreadyActive, 1);
assert.equal(applied.summary.bridgeMaterialized, 2);
assert.equal(applied.summary.blocked, 1);
assert.equal(applyDeps.inserted.length, 1);
assert.equal(applyDeps.inserted[0].symbol, 'BTC/USDT');
assert.equal(applyDeps.inserted[0].waitingFor, 'luna_entry_trigger_fire_conditions');
assert.equal(applyDeps.inserted[0].triggerContext.hints.promotionReady, true);
assert.equal(applyDeps.inserted[0].triggerContext.hints.promotionConsecutivePasses, 5);
assert.equal(applyDeps.inserted[0].triggerMeta.liveMutation, false);
assert.equal(applyDeps.inserted[0].triggerMeta.entryTriggerDbMutation, true);
assert.equal(applyDeps.marked.length, 2);
assert.equal(applyDeps.marked[0].bridgeId, 'bridge-btc');
assert.equal(applyDeps.marked[1].bridgeId, 'bridge-eth');
assert.equal(applyDeps.marked[1].entryTriggerId, 'active-eth');
assert.equal(applied.liveMutation, false);
assert.equal(applied.entryTriggerDbMutation, true);

const payload = {
  smoke: 'luna-promotion-entry-trigger-materialize',
  ok: true,
  dryRunStatus: dryRun.status,
  appliedMaterialized: applied.summary.materialized,
  blocked: applied.summary.blocked,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-promotion-entry-trigger-materialize-smoke ok');
}
