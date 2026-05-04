#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';

function withEnv(patch = {}, fn) {
  const prev = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

export async function runLunaEntryTriggerDuplicateCooldownSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_COOLDOWN_MINUTES: '30',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
  }, async () => {
    const symbol = `DUPCOOL${Date.now().toString(36).toUpperCase()}/USDT`;
    const candidate = {
      symbol,
      action: 'BUY',
      confidence: 0.8,
      amount_usdt: 100,
      entry_price: 100,
      atr: 2,
      setup_type: 'breakout_confirmation',
      triggerHints: { mtfAgreement: 0.9, discoveryScore: 0.8, breakoutRetest: true },
    };
    const context = {
      exchange: 'binance',
      capitalSnapshot: {
        mode: 'ACTIVE_DISCOVERY',
        balanceStatus: 'ok',
        buyableAmount: 500,
        minOrderAmount: 10,
        remainingSlots: 2,
      },
    };
    try {
      const first = await evaluateEntryTriggers([candidate], context);
      assert.equal(first.stats.fired, 1);
      assert.equal(first.decisions[0].action, 'BUY');

      const second = await evaluateEntryTriggers([{ ...candidate, reasoning: 'second duplicate' }], context);
      assert.equal(second.stats.fired, 0);
      assert.equal(second.stats.blocked, 1);
      assert.equal(second.decisions[0].action, 'HOLD');
      assert.equal(second.decisions[0].block_meta?.entryTrigger?.reason, 'duplicate_fire_cooldown');

      return { ok: true, first: first.stats, second: second.stats };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaEntryTriggerDuplicateCooldownSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger duplicate cooldown smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry trigger duplicate cooldown smoke 실패:',
  });
}
