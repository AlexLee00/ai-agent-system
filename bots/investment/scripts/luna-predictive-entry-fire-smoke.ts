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

function candidate(symbol, overrides = {}) {
  return {
    symbol,
    action: 'BUY',
    confidence: 0.82,
    amount_usdt: 100,
    setup_type: 'breakout_confirmation',
    triggerHints: {
      mtfAgreement: 0.9,
      discoveryScore: 0.84,
      breakoutRetest: true,
      volumeBurst: 2.1,
    },
    ...overrides,
  };
}

export async function runLunaPredictiveEntryFireSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT: 'true',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
    LUNA_PREDICTIVE_VALIDATION_ENABLED: 'true',
    LUNA_PREDICTIVE_VALIDATION_MODE: 'hard_gate',
    LUNA_PREDICTIVE_VALIDATION_THRESHOLD: '0.55',
  }, async () => {
    const weakSymbol = `PREDWEAK${Date.now().toString(36).toUpperCase()}/USDT`;
    const strongSymbol = weakSymbol.replace('PREDWEAK', 'PREDPASS');
    const capitalSnapshot = {
      mode: 'ACTIVE_DISCOVERY',
      balanceStatus: 'ok',
      buyableAmount: 500,
      minOrderAmount: 10,
      remainingSlots: 2,
    };
    try {
      const weak = await evaluateEntryTriggers([
        candidate(weakSymbol, {
          predictiveScore: 0.36,
          backtest: { winRate: 0.35, avgPnlPercent: -2.4, sharpe: -0.2 },
          prediction: { breakout_probability: 0.32, trend_cont_probability: 0.38 },
          analystAccuracy: { aria: 0.42, oracle: 0.44 },
          setupOutcome: { winRate: 0.33, avgPnlPercent: -1.2 },
        }),
      ], { exchange: 'binance', capitalSnapshot, regime: 'trending_bull' });
      assert.equal(weak.stats.fired, 0);
      assert.equal(weak.stats.blocked, 1);
      assert.equal(weak.decisions[0].action, 'HOLD');
      assert.equal(weak.decisions[0].block_meta?.entryTrigger?.riskGateReason, 'predictive_validation_discard');

      const strong = await evaluateEntryTriggers([
        candidate(strongSymbol, {
          predictiveScore: 0.78,
          backtest: { winRate: 0.66, avgPnlPercent: 2.2, sharpe: 1.2 },
          prediction: { breakout_probability: 0.76, trend_cont_probability: 0.72 },
          analystAccuracy: { aria: 0.64, oracle: 0.68 },
          setupOutcome: { winRate: 0.61, avgPnlPercent: 1.8 },
        }),
      ], { exchange: 'binance', capitalSnapshot, regime: 'trending_bull' });
      assert.equal(strong.stats.fired, 1);
      assert.equal(strong.decisions[0].action, 'BUY');

      return {
        ok: true,
        weak: weak.decisions[0].block_meta?.entryTrigger,
        strong: strong.decisions[0].block_meta?.entryTrigger,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1 OR symbol = $2`, [weakSymbol, strongSymbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaPredictiveEntryFireSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna predictive entry fire smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna predictive entry-fire smoke 실패:',
  });
}
