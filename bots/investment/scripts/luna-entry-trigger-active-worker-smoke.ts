#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { insertEntryTrigger } from '../shared/luna-discovery-entry-store.ts';
import { evaluateActiveEntryTriggersAgainstMarketEvents } from '../shared/entry-trigger-engine.ts';

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

export async function runLunaEntryTriggerActiveWorkerSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
  }, async () => {
    const symbol = `ACTIVE${Date.now().toString(36).toUpperCase()}/USDT`;
    try {
      const trigger = await insertEntryTrigger({
        symbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'breakout_confirmation',
        triggerState: 'armed',
        confidence: 0.78,
        waitingFor: 'breakout_confirmation',
        triggerContext: {
          hints: { mtfAgreement: 0.7, discoveryScore: 0.7 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(trigger?.id);

      const result = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol,
          mtfAgreement: 0.82,
          discoveryScore: 0.79,
          breakoutRetest: true,
          volumeBurst: 2.0,
        },
      ], {
        exchange: 'binance',
        capitalSnapshot: {
          mode: 'ACTIVE_DISCOVERY',
          balanceStatus: 'ok',
          buyableAmount: 500,
          minOrderAmount: 10,
          remainingSlots: 2,
        },
      });
      assert.equal(result.enabled, true);
      assert.equal(result.checked, 1);
      assert.equal(result.fired, 1);
      assert.equal(result.results[0].fired, true);

      const row = await db.get(`SELECT trigger_state FROM entry_triggers WHERE id = $1`, [trigger.id]);
      assert.equal(row?.trigger_state, 'fired');

      return {
        ok: true,
        triggerId: trigger.id,
        result,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaEntryTriggerActiveWorkerSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger active-worker smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger active-worker smoke 실패:',
  });
}
