#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { insertEntryTrigger } from '../shared/luna-discovery-entry-store.ts';
import {
  evaluateActiveEntryTriggersAgainstMarketEvents,
  refreshEntryTriggersFromRecentBuySignals,
} from '../shared/entry-trigger-engine.ts';

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
    const refreshSymbol = `REFRESH${Date.now().toString(36).toUpperCase()}/USDT`;
    const openSymbol = `OPENPOS${Date.now().toString(36).toUpperCase()}/USDT`;
    let signalId = null;
    let openSignalId = null;
    try {
      signalId = await db.insertSignal({
        symbol: refreshSymbol,
        action: 'BUY',
        amountUsdt: 50,
        confidence: 0.82,
        reasoning: 'refresh signal continuity test',
        status: 'approved',
        exchange: 'binance',
        strategyFamily: 'breakout',
      });
      await db.run(
        `UPDATE signals SET block_meta = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ atr: 2, entry_price: 100, tp_sl_set: true }), signalId],
      );
      const refresh = await refreshEntryTriggersFromRecentBuySignals({ exchange: 'binance', hours: 1, limit: 5 });
      assert.ok(refresh.sourceSignals >= 1, 'recent BUY signal should be considered for entry-trigger refresh');
      assert.ok(refresh.armed >= 1 || refresh.observed >= 1, 'recent BUY signal should arm or observe an entry trigger');

      openSignalId = await db.insertSignal({
        symbol: openSymbol,
        action: 'BUY',
        amountUsdt: 50,
        confidence: 0.9,
        reasoning: 'open position entry trigger should not be refreshed',
        status: 'approved',
        exchange: 'binance',
        strategyFamily: 'breakout',
      });
      await db.run(
        `UPDATE signals SET block_meta = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ atr: 2, entry_price: 100, tp_sl_set: true }), openSignalId],
      );
      const openRefresh = await refreshEntryTriggersFromRecentBuySignals({
        exchange: 'binance',
        hours: 1,
        limit: 10,
        context: { openPositionSymbols: [openSymbol] },
      });
      assert.ok(openRefresh.sourceSignals >= 1, 'open position BUY signal should still be inspected');
      const openRows = await db.query(
        `SELECT * FROM entry_triggers WHERE symbol = $1 AND trigger_state IN ('armed', 'waiting')`,
        [openSymbol],
      );
      assert.equal(openRows.length, 0, 'open position symbol must not keep active entry triggers');

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
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
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

      const openTrigger = await insertEntryTrigger({
        symbol: openSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'breakout_confirmation',
        triggerState: 'armed',
        confidence: 0.8,
        waitingFor: 'breakout_confirmation',
        triggerContext: {
          hints: { mtfAgreement: 0.8, discoveryScore: 0.8 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(openTrigger?.id);
      const openEventResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: openSymbol,
          mtfAgreement: 0.85,
          discoveryScore: 0.8,
          breakoutRetest: true,
        },
      ], {
        exchange: 'binance',
        openPositionSymbols: [openSymbol],
      });
      assert.equal(openEventResult.checked, 0, 'open position trigger should be expired before event evaluation');
      const expiredOpenTrigger = await db.get(`SELECT trigger_state FROM entry_triggers WHERE id = $1`, [openTrigger.id]);
      assert.equal(expiredOpenTrigger?.trigger_state, 'expired');

      return {
        ok: true,
        triggerId: trigger.id,
        result,
        openEventResult,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [refreshSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [openSymbol]).catch(() => {});
      if (signalId) await db.run(`DELETE FROM signals WHERE id = $1`, [signalId]).catch(() => {});
      if (openSignalId) await db.run(`DELETE FROM signals WHERE id = $1`, [openSignalId]).catch(() => {});
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
