#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';
import * as db from '../shared/db.ts';

const ACTIONS = { BUY: 'BUY', HOLD: 'HOLD' };

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

export async function runLunaEntryTriggerShadowSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'shadow',
    LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW: 'false',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.45',
  }, async () => {
    const symbol = `SHADOW${Date.now().toString(36).toUpperCase()}/USDT`;
    const input = [{
      symbol,
      action: ACTIONS.BUY,
      confidence: 0.71,
      amount_usdt: 100,
      entry_price: 100,
      atr: 2,
      reasoning: 'shadow trigger test',
      setup_type: 'breakout_confirmation',
      triggerHints: {
        mtfAgreement: 0.8,
        discoveryScore: 0.78,
        breakoutRetest: true,
        volumeBurst: 2.2,
      },
    }];
    try {
      const result = await evaluateEntryTriggers(input, { exchange: 'binance' });
      assert.equal(result.stats.enabled, true);
      assert.equal(result.decisions.length, 1);
      assert.equal(result.decisions[0].action, ACTIONS.BUY);
      assert.equal(result.stats.observed, 1);
      assert.equal(result.decisions[0]?.block_meta?.entryTrigger?.observedOnly, true);
      return {
        ok: true,
        stats: result.stats,
        decision: result.decisions[0],
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaEntryTriggerShadowSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger shadow smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger shadow smoke 실패:',
  });
}
