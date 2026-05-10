#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  classifyLunaOperatingTimestamp,
  filterRowsForPolicyLearning,
  getLunaOperatingEpoch,
} from '../shared/luna-operating-epoch.ts';
import { checkTradeDataWeakSymbol, evaluateLearningTradeQuality } from '../shared/trade-data-derived-guards.ts';
import { evaluateLunaConstitutionForEntry } from '../shared/luna-constitution.ts';
import { buildLunaDynamicPolicyDecision } from '../shared/luna-dynamic-policy-arbiter.ts';

export async function runSmoke() {
  const env = {
    LUNA_OPERATING_EPOCH_ENABLED: 'true',
    LUNA_OPERATING_EPOCH_STARTED_AT: '2026-05-08T00:00:00.000Z',
  };
  const epoch = getLunaOperatingEpoch(env);
  const epochStartMs = Date.parse(env.LUNA_OPERATING_EPOCH_STARTED_AT);
  assert.equal(epoch.enabled, true);
  assert.equal(classifyLunaOperatingTimestamp('2026-05-07T23:59:59.000Z', env).stage, 'development');
  assert.equal(classifyLunaOperatingTimestamp('2026-05-08T00:00:00.000Z', env).stage, 'operating');
  assert.equal(classifyLunaOperatingTimestamp(epochStartMs, env).stage, 'operating');
  assert.equal(classifyLunaOperatingTimestamp(String(epochStartMs - 1000), env).stage, 'development');
  assert.equal(classifyLunaOperatingTimestamp(Math.floor(epochStartMs / 1000), env).stage, 'operating');

  const rows = filterRowsForPolicyLearning([
    { id: 'dev', created_at: '2026-05-07T12:00:00.000Z' },
    { id: 'live', created_at: '2026-05-08T12:00:00.000Z' },
    { id: 'epoch-ms', entry_time: String(epochStartMs + 60_000) },
  ], ['created_at'], env);
  const mixedRows = filterRowsForPolicyLearning([
    { id: 'dev', created_at: '2026-05-07T12:00:00.000Z' },
    { id: 'live', created_at: '2026-05-08T12:00:00.000Z' },
    { id: 'epoch-ms', entry_time: String(epochStartMs + 60_000) },
  ], ['created_at', 'entry_time'], env);
  assert.deepEqual(rows.map((row) => row.id), ['live']);
  assert.deepEqual(mixedRows.map((row) => row.id), ['live', 'epoch-ms']);

  const weakDefault = checkTradeDataWeakSymbol('OPN/USDT', 'crypto', env);
  assert.equal(weakDefault.blocked, false, 'dev-stage weak symbol stats must not hard block by default');
  assert.equal(weakDefault.source, 'pre_entry/trade_data_weak_symbol_development_stage');
  const weakExplicit = checkTradeDataWeakSymbol('OPN/USDT', 'crypto', {
    ...env,
    LUNA_ALLOW_DEV_DATA_DERIVED_GUARDS: 'true',
  });
  assert.equal(weakExplicit.blocked, true, 'explicit override may re-enable historical hard guard');

  const devQuality = evaluateLearningTradeQuality({
    status: 'closed',
    created_at: '2026-05-07T12:00:00.000Z',
    entry_price: 100,
    exit_price: 101,
    pnl_percent: 1,
    tp_sl_set: true,
  }, env);
  assert.equal(devQuality.excludeFromLearning, true);
  assert.ok(devQuality.reasons.includes('development_stage_before_operating_epoch'));

  const softConstitution = evaluateLunaConstitutionForEntry({
    action: 'BUY',
    market: 'domestic',
    confidence: 0.8,
    market_regime: 'trending_bear',
    stop_loss: 98,
    take_profit: 104,
  }, { env, now: '2026-05-08T01:00:00.000Z' });
  assert.equal(softConstitution.blocked, false, 'pre-epoch domestic bear stats must be advisory');
  assert.ok(softConstitution.violations.some((item) => item.code === 'domestic_trending_bear_development_stage_reference'));

  const dynamic = buildLunaDynamicPolicyDecision({
    market: 'crypto',
    signalSummary: { totalBuy: 4, executedSignals: 0 },
    decisionFilterSummary: { reasonCounts: { technical_not_confirmed: 2 } },
    operatingEpochSummary: { operating: 1 },
    env,
  });
  assert.equal(dynamic.status, 'collect_operating_epoch_samples');
  assert.ok(dynamic.suggestions.some((item) => item.action === 'collect_operating_epoch_samples'));

  return {
    ok: true,
    epoch,
    weakDefault,
    softConstitution: softConstitution.violations.map((item) => ({ code: item.code, severity: item.severity })),
    dynamic: { status: dynamic.status, suggestions: dynamic.suggestions.length },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-operating-epoch-smoke status=${result.dynamic.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-operating-epoch-smoke 실패:' });
}
