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

async function waitForGuardEvent(symbol, guardName, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    const rows = await db.query(
      `SELECT guard_name, reason, decision_after
         FROM investment.guard_events
        WHERE symbol = $1 AND guard_name = $2
        ORDER BY triggered_at DESC
        LIMIT 1`,
      [symbol, guardName],
    ).catch(() => []);
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

export async function runLunaEntryTriggerRiskGateSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT: 'true',
    LUNA_ENTRY_TRIGGER_REQUIRE_CAPITAL_ACTIVE: 'true',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
  }, async () => {
    const symbol = `RISKGATE${Date.now().toString(36).toUpperCase()}/USDT`;
    const allowedSymbol = symbol.replace('/USDT', '2/USDT');
    const capitalBlockedSymbol = symbol.replace('/USDT', '3/USDT');
    const candidate = {
      symbol,
      action: 'BUY',
      confidence: 0.82,
      amount_usdt: 100,
      entry_price: 100,
      atr: 2,
      setup_type: 'breakout_confirmation',
      triggerHints: { mtfAgreement: 0.9, discoveryScore: 0.82, breakoutRetest: true },
      tradingViewSnapshot: {
        ok: true,
        source: 'tradingview_ws_service',
        providerMode: 'websocket',
        market: 'tradingview',
        price: 101,
        open: 100,
        stale: false,
      },
    };
    try {
      const notified = await evaluateEntryTriggers([candidate], { exchange: 'binance' });
      assert.equal(notified.stats.fired, 1);
      assert.equal(notified.stats.blocked, 0);
      assert.equal(notified.decisions[0].action, 'BUY');
      const riskNotify = await waitForGuardEvent(symbol, 'live_risk_gate_notify');
      assert.equal(riskNotify?.reason, 'risk_context_missing');
      assert.equal(riskNotify?.decision_after?.notifyMode, true);

      const capitalBlocked = await evaluateEntryTriggers([{ ...candidate, symbol: capitalBlockedSymbol }], {
        exchange: 'binance',
        capitalSnapshot: {
          mode: 'ACTIVE_DISCOVERY',
          balanceStatus: 'ok',
          buyableAmount: 0,
          minOrderAmount: 10,
          remainingSlots: 2,
        },
      });
      assert.equal(capitalBlocked.stats.fired, 0);
      assert.equal(capitalBlocked.stats.blocked, 1);
      assert.equal(capitalBlocked.decisions[0].action, 'HOLD');
      assert.equal(capitalBlocked.decisions[0].block_meta?.entryTrigger?.reason, 'live_risk_gate_capital_hard_block');
      assert.equal(capitalBlocked.decisions[0].block_meta?.entryTrigger?.riskGateReason, 'buyable_amount_below_required');

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
        notified: notified.decisions[0].block_meta?.entryTrigger,
        capitalBlocked: capitalBlocked.decisions[0].block_meta?.entryTrigger,
        allowed: allowed.decisions[0].block_meta?.entryTrigger,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = ANY($1::text[])`, [[symbol, allowedSymbol, capitalBlockedSymbol]]).catch(() => {});
      await db.run(`DELETE FROM investment.guard_events WHERE symbol = ANY($1::text[])`, [[symbol, allowedSymbol, capitalBlockedSymbol]]).catch(() => {});
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
