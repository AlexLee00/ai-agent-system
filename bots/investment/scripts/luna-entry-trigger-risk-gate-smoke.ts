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

export async function runLunaEntryTriggerRiskGateSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT: 'true',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
  }, async () => {
    const symbol = `RISKGATE${Date.now().toString(36).toUpperCase()}/USDT`;
    const allowedSymbol = symbol.replace('/USDT', '2/USDT');
    const candidate = {
      symbol,
      action: 'BUY',
      confidence: 0.82,
      amount_usdt: 100,
      setup_type: 'breakout_confirmation',
      triggerHints: { mtfAgreement: 0.9, discoveryScore: 0.82, breakoutRetest: true },
    };
    try {
      const blocked = await evaluateEntryTriggers([candidate], { exchange: 'binance' });
      assert.equal(blocked.stats.fired, 0);
      assert.equal(blocked.stats.blocked, 1);
      assert.equal(blocked.decisions[0].action, 'HOLD');
      assert.equal(blocked.decisions[0].block_meta?.entryTrigger?.reason, 'live_risk_gate_blocked');
      assert.equal(blocked.decisions[0].block_meta?.entryTrigger?.riskGateReason, 'risk_context_missing');

      const allowed = await evaluateEntryTriggers([{ ...candidate, symbol: allowedSymbol }], {
        exchange: 'binance',
        capitalSnapshot: {
          mode: 'ACTIVE_DISCOVERY',
          balanceStatus: 'ok',
          buyableAmount: 500,
          minOrderAmount: 10,
          remainingSlots: 2,
        },
      });
      assert.equal(allowed.stats.fired, 1);
      assert.equal(allowed.decisions[0].action, 'BUY');

      return {
        ok: true,
        blocked: blocked.decisions[0].block_meta?.entryTrigger,
        allowed: allowed.decisions[0].block_meta?.entryTrigger,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1 OR symbol = $2`, [symbol, allowedSymbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaEntryTriggerRiskGateSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger risk gate smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger risk-gate smoke 실패:',
  });
}
