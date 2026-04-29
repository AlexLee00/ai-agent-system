#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { buildPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const cfg = getPosttradeFeedbackRuntimeConfig();
  const cycle = cfg?.market_differentiated?.cycle_days || {};
  assert.ok(Number(cycle.crypto) >= 1, 'crypto cycle configured');
  assert.ok(Number(cycle.domestic) >= 1, 'domestic cycle configured');
  assert.ok(Number(cycle.overseas) >= 1, 'overseas cycle configured');

  const [crypto, domestic, overseas] = await Promise.all([
    buildPosttradeFeedbackDashboard({ days: Number(cycle.crypto || 3), market: 'crypto' }),
    buildPosttradeFeedbackDashboard({ days: Number(cycle.domestic || 7), market: 'domestic' }),
    buildPosttradeFeedbackDashboard({ days: Number(cycle.overseas || 7), market: 'overseas' }),
  ]);
  assert.equal(crypto.market, 'crypto', 'crypto dashboard route');
  assert.equal(domestic.market, 'domestic', 'domestic dashboard route');
  assert.equal(overseas.market, 'overseas', 'overseas dashboard route');

  return {
    ok: true,
    cycles: cycle,
    totals: {
      crypto: crypto?.quality?.total ?? 0,
      domestic: domestic?.quality?.total ?? 0,
      overseas: overseas?.quality?.total ?? 0,
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-market-differentiated-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-market-differentiated-smoke 실패:',
  });
}

