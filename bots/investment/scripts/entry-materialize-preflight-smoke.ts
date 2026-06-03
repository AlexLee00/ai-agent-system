#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  evaluateEntryMaterializePreflight,
  runEntryMaterializePreflightShadow,
} from '../shared/entry-materialize-preflight.ts';

function baseDeps(overrides = {}) {
  return {
    getOpenPositions: async () => [],
    getCapitalConfig: () => ({ max_concurrent_positions: 2 }),
    getLivePosition: async () => null,
    preTradeCheck: async () => ({ allowed: true }),
    calculatePositionSize: async () => ({ size: 50, skip: false }),
    getDynamicMinOrderAmount: async () => 11,
    ...overrides,
  };
}

async function run() {
  const trigger = { id: 'trigger-smoke', symbol: 'BTC/USDT', exchange: 'binance', confidence: 0.8 };

  const off = await runEntryMaterializePreflightShadow({
    trigger,
    exchange: 'binance',
    amountUsdt: 50,
    env: {},
    deps: { ...baseDeps(), record: false },
  });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'ENTRY_PREFLIGHT_SHADOW_ENABLED=false');

  const capital = await evaluateEntryMaterializePreflight({
    trigger,
    exchange: 'binance',
    amountUsdt: 50,
    deps: baseDeps({
      getOpenPositions: async () => [{ symbol: 'ETH/USDT' }, { symbol: 'SOL/USDT' }],
      getCapitalConfig: () => ({ max_concurrent_positions: 2 }),
    }),
  });
  assert.equal(capital.decision, 'defer_capital_full');
  assert.equal(capital.wouldDefer, true);

  const reentry = await evaluateEntryMaterializePreflight({
    trigger,
    exchange: 'binance',
    amountUsdt: 50,
    deps: baseDeps({
      getLivePosition: async () => ({ symbol: 'BTC/USDT', amount: 0.01, paper: false }),
    }),
  });
  assert.equal(reentry.decision, 'skip_existing_position');

  const minOrder = await evaluateEntryMaterializePreflight({
    trigger,
    exchange: 'binance',
    amountUsdt: 50,
    deps: baseDeps({
      calculatePositionSize: async () => ({ size: 16.82, skip: false }),
      getDynamicMinOrderAmount: async () => 44.23,
    }),
  });
  assert.equal(minOrder.decision, 'defer_min_order');

  const allow = await evaluateEntryMaterializePreflight({
    trigger,
    exchange: 'binance',
    amountUsdt: 50,
    deps: baseDeps(),
  });
  assert.equal(allow.decision, 'allow');

  console.log(JSON.stringify({
    ok: true,
    cases: {
      off: off.reason,
      capital: capital.decision,
      reentry: reentry.decision,
      minOrder: minOrder.decision,
      allow: allow.decision,
    },
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
