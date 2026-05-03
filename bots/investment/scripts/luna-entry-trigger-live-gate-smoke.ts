#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';
import * as db from '../shared/db.ts';

const ACTIONS = { BUY: 'BUY' };

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

export async function runLunaEntryTriggerLiveGateSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.45',
  }, async () => {
    const symbol = `LIVEGATE${Date.now().toString(36).toUpperCase()}/USDT`;
    const input = [{
      symbol,
      action: ACTIONS.BUY,
      confidence: 0.74,
      amount_usdt: 120,
      reasoning: 'live gate smoke',
      setup_type: 'breakout_confirmation',
      triggerHints: {
        mtfAgreement: 0.81,
        discoveryScore: 0.8,
        breakoutRetest: true,
        volumeBurst: 2.1,
      },
    }];
    try {
      const result = await evaluateEntryTriggers(input, {
        exchange: 'binance',
        capitalSnapshot: {
          mode: 'ACTIVE_DISCOVERY',
          balanceStatus: 'ok',
          buyableAmount: 500,
          minOrderAmount: 10,
          remainingSlots: 2,
        },
      });
      assert.equal(result.stats.enabled, true);
      assert.equal(result.decisions.length, 1);
      assert.equal(result.decisions[0].action, ACTIONS.BUY);
      assert.equal(result.decisions[0]?.block_meta?.entryTrigger?.state, 'fired');
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
  const result = await runLunaEntryTriggerLiveGateSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger live gate smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger live-gate smoke 실패:',
  });
}
