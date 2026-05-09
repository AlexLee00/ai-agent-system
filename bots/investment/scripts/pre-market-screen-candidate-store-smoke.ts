#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildPreScreenedCandidateSignals,
} from './pre-market-screen.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runPreMarketScreenCandidateStoreSmoke() {
  const domestic = buildPreScreenedCandidateSignals('domestic', ['005930', '000660', '005930'], {
    label: '국내주식',
    source: 'pre_market_screen',
  });
  assert.equal(domestic.length, 2);
  assert.equal(domestic[0].symbol, '005930');
  assert.equal(domestic[0].reasonCode, 'pre_market_screen');
  assert.ok(domestic[0].ttlHours >= 24);
  assert.ok(domestic[0].score > domestic[1].score, 'candidate rank should be reflected in score ordering');

  const overseas = buildPreScreenedCandidateSignals('overseas', ['nvda', 'aapl'], {
    label: '미국주식',
    source: 'off_hours_research_watchlist',
    research: { mode: 'off_hours', phase: 'analysis_only' },
  });
  assert.equal(overseas[0].symbol, 'NVDA');
  assert.equal(overseas[0].reasonCode, 'off_hours_research_watchlist');
  assert.ok(overseas[0].ttlHours >= 72, 'off-hours research candidates should bridge weekend/holiday gaps');

  return {
    ok: true,
    smoke: 'pre-market-screen-candidate-store',
    domesticCount: domestic.length,
    overseasCount: overseas.length,
  };
}

async function main() {
  const result = await runPreMarketScreenCandidateStoreSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('pre-market-screen-candidate-store-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ pre-market-screen-candidate-store-smoke 실패:',
  });
}
