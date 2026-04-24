#!/usr/bin/env node
// @ts-nocheck

import { strict as assert } from 'node:assert';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildUpdates, overrideKeyForExchange } from './runtime-position-runtime-autotune.ts';

export function runRuntimePositionRuntimeAutotuneSmoke() {
  assert.equal(overrideKeyForExchange('binance'), 'position_watch_crypto_realtime_ms');
  assert.equal(overrideKeyForExchange('kis'), 'position_watch_domestic_realtime_ms');
  assert.equal(overrideKeyForExchange('kis_overseas'), 'position_watch_overseas_realtime_ms');

  const { updates, appliedSuggestions } = buildUpdates([
    {
      exchange: 'kis',
      status: 'tighten_runtime_watch',
      recommendedCadenceMs: 15_000,
      currentAverageCadenceMs: 20_000,
      reason: 'domestic pressure',
    },
    {
      exchange: 'kis_overseas',
      status: 'relax_runtime_watch',
      recommendedCadenceMs: 21_250,
      currentAverageCadenceMs: 15_000,
      reason: 'overseas balanced',
    },
    {
      exchange: 'binance',
      status: 'tighten_runtime_watch',
      recommendedCadenceMs: 10_000,
      currentAverageCadenceMs: 10_000,
      reason: 'crypto pressure',
    },
  ]);

  assert.equal(updates.position_watch_domestic_realtime_ms, 15_000);
  assert.equal(updates.position_watch_overseas_realtime_ms, 21_250);
  assert.equal(updates.position_watch_crypto_realtime_ms, 10_000);
  assert.equal(
    Object.prototype.hasOwnProperty.call(updates, 'position_watch_stock_realtime_ms'),
    false,
  );

  const byExchange = new Map(appliedSuggestions.map((item) => [item.exchange, item]));
  assert.equal(byExchange.get('kis')?.key, 'position_watch_domestic_realtime_ms');
  assert.equal(byExchange.get('kis_overseas')?.key, 'position_watch_overseas_realtime_ms');
  assert.equal(byExchange.get('binance')?.key, 'position_watch_crypto_realtime_ms');

  return { ok: true };
}

async function main() {
  runRuntimePositionRuntimeAutotuneSmoke();
  console.log('runtime position runtime autotune smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position runtime autotune smoke 실패:',
  });
}
