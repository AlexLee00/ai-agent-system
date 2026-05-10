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
import {
  buildEntryTriggerWorkerRiskContext,
  materializeFiredEntryTriggerSignals,
} from './luna-entry-trigger-worker.ts';

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
    LUNA_MAX_TRADE_USDT: '50',
  }, async () => {
    const symbol = `ACTIVE${Date.now().toString(36).toUpperCase()}/USDT`;
    const pullbackSymbol = `PULLBACK${Date.now().toString(36).toUpperCase()}/USDT`;
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

      const capitalSnapshot = {
        mode: 'ACTIVE_DISCOVERY',
        balanceStatus: 'ok',
        buyableAmount: 500,
        minOrderAmount: 10,
        remainingSlots: 2,
      };

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
        capitalSnapshot,
      });
      assert.equal(result.enabled, true);
      assert.equal(result.checked, 1);
      assert.equal(result.fired, 1);
      assert.equal(result.results[0].fired, true);

      const row = await db.get(`SELECT trigger_state FROM entry_triggers WHERE id = $1`, [trigger.id]);
      assert.equal(row?.trigger_state, 'fired');

      const pullbackTrigger = await insertEntryTrigger({
        symbol: pullbackSymbol,
        exchange: 'binance',
        setupType: 'mean_reversion',
        triggerType: 'pullback_to_support',
        triggerState: 'armed',
        confidence: 0.73,
        predictiveScore: 0.63,
        targetPrice: 101,
        waitingFor: 'pullback_to_support',
        triggerContext: {
          hints: { mtfAgreement: 0, discoveryScore: 0.62, volumeBurst: 0.55, breakoutRetest: false },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(pullbackTrigger?.id);
      const pullbackResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: pullbackSymbol,
          price: 101,
          targetPrice: 101,
          mtfAgreement: 0,
          discoveryScore: 0.62,
          volumeBurst: 0.55,
          breakoutRetest: true,
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
        capitalSnapshot,
      });
      assert.equal(pullbackResult.checked, 1);
      assert.equal(pullbackResult.fired, 1);
      assert.equal(pullbackResult.results[0].fired, true);

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

      const workerRiskContext = await buildEntryTriggerWorkerRiskContext({
        exchange: 'binance',
        buyingPowerSnapshotBuilder: async () => capitalSnapshot,
      });
      assert.equal(workerRiskContext.capitalSnapshot.mode, 'ACTIVE_DISCOVERY');
      assert.equal(workerRiskContext.capitalSnapshot.buyableAmount, 500);

      const materializedPayloads = [];
      const materializedMeta = [];
      const materializedUpdates = [];
      const materializeResult = await materializeFiredEntryTriggerSignals({
        exchange: 'binance',
        result: {
          allowLiveFire: true,
          results: [{ triggerId: 'fake-trigger-1', symbol: 'FAKE/USDT', fired: true }],
        },
        riskContext: { capitalSnapshot },
        events: [{ symbol: 'FAKE/USDT', price: 101, targetPrice: 101 }],
        deps: {
          triggerFetcher: async () => ({
            id: 'fake-trigger-1',
            symbol: 'FAKE/USDT',
            exchange: 'binance',
            setup_type: 'mean_reversion',
            trigger_type: 'pullback_to_support',
            trigger_state: 'fired',
            confidence: 0.73,
            predictive_score: 0.63,
            trigger_context: {
              strategyRoute: {
                selectedFamily: 'mean_reversion',
                setupType: 'pullback_to_support',
                quality: 'watch',
                readinessScore: 0.66,
              },
              strategyQuality: 'watch',
              strategyReadiness: 0.66,
            },
            trigger_meta: {},
          }),
          duplicateFinder: async () => null,
          signalInserter: async (payload) => {
            materializedPayloads.push(payload);
            return 'fake-signal-1';
          },
          blockMetaMerger: async (id, meta) => {
            materializedMeta.push({ id, meta });
          },
          triggerUpdater: async (id, patch) => {
            materializedUpdates.push({ id, patch });
          },
        },
      });
      assert.equal(materializeResult.enabled, true);
      assert.equal(materializeResult.materialized, 1);
      assert.equal(materializedPayloads[0].status, 'approved');
      assert.equal(materializedPayloads[0].executionOrigin, 'entry_trigger');
      assert.equal(materializedPayloads[0].nemesisVerdict, 'approved');
      assert.equal(materializedPayloads[0].amountUsdt, 50);
      assert.equal(materializedPayloads[0].strategyFamily, 'mean_reversion');
      assert.equal(materializedPayloads[0].strategyQuality, 'watch');
      assert.equal(materializedPayloads[0].strategyReadiness, 0.66);
      assert.equal(materializedPayloads[0].strategyRoute.readinessScore, 0.66);
      assert.equal(materializedMeta[0].meta.event_type, 'entry_trigger_fired_signal_materialized');
      assert.equal(materializedMeta[0].meta.entryTrigger.strategy.quality, 'watch');
      assert.equal(materializedUpdates[0].patch.triggerMetaPatch.materializeStatus, 'approved_signal_inserted');

      return {
        ok: true,
        triggerId: trigger.id,
        result,
        pullbackResult,
        openEventResult,
        workerRiskContext,
        materializeResult,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [pullbackSymbol]).catch(() => {});
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
