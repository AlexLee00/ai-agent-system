#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';
import { applyPredictiveValidationGate } from '../shared/predictive-validation-gate.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';
import * as db from '../shared/db.ts';

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

export async function runLunaModeSafetySmoke() {
  return withEnv({
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'shadow',
    LUNA_DISCOVERY_SCORE_FUSION_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW: 'false',
    LUNA_PREDICTIVE_VALIDATION_ENABLED: 'true',
    LUNA_PREDICTIVE_VALIDATION_MODE: 'hard_gate',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
  }, async () => {
    const symbol = `MODESAFE${Date.now().toString(36).toUpperCase()}/USDT`;
    const flags = getLunaIntelligentDiscoveryFlags();
    assert.equal(flags.mode, 'shadow');
    assert.equal(flags.shouldApplyDecisionMutation(), false);
    assert.equal(flags.shouldApplyScoreFusion(), false);
    assert.equal(flags.shouldEntryTriggerMutate(), false);
    assert.equal(flags.predictive.mode, 'advisory');

    const predictive = applyPredictiveValidationGate([
      { symbol, action: 'BUY', confidence: 0.8, predictiveScore: 0.1, amount_usdt: 100 },
    ], flags.predictive);
    assert.equal(predictive.blocked, 0);
    assert.equal(predictive.advisory, 1);
    assert.equal(predictive.decisions[0].action, 'BUY');

    try {
      const trigger = await evaluateEntryTriggers([
        {
          symbol,
          action: 'BUY',
          confidence: 0.8,
          amount_usdt: 100,
          setup_type: 'breakout_confirmation',
          triggerHints: { mtfAgreement: 0.9, discoveryScore: 0.8, breakoutRetest: true },
        },
      ], { exchange: 'binance' });
      assert.equal(trigger.stats.observed, 1);
      assert.equal(trigger.decisions[0].action, 'BUY');
      assert.equal(trigger.decisions[0].amount_usdt, 100);

      return {
        ok: true,
        mode: flags.mode,
        predictive: { blocked: predictive.blocked, advisory: predictive.advisory },
        triggerStats: trigger.stats,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaModeSafetySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna mode safety smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna mode safety smoke 실패:',
  });
}
