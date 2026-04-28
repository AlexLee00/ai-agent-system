#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { detectWyckoffPhase } from '../shared/wyckoff-phase-detector.ts';
import { classifyVsaBar } from '../shared/vsa-bar-classifier.ts';

function buildSyntheticCandles(count = 60) {
  const rows = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = i < 20 ? -0.1 : i < 40 ? 0.05 : 0.35;
    const open = price;
    const close = Math.max(1, open + drift + ((i % 3) - 1) * 0.08);
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    const volume = 1000 + i * 20 + (i > 40 ? 500 : 0);
    rows.push([Date.now() - (count - i) * 60_000, open, high, low, close, volume]);
    price = close;
  }
  return rows;
}

export function runLunaWyckoffVsaSmoke() {
  const candles = buildSyntheticCandles(80);
  const wyckoff = detectWyckoffPhase(candles);
  assert.ok(typeof wyckoff.phase === 'string');
  assert.ok(Number(wyckoff.confidence) >= 0.3);

  const vsa = classifyVsaBar(candles[candles.length - 1], candles.slice(-30, -1));
  assert.ok('pattern' in vsa);
  assert.ok(Number(vsa.strength) >= 0);

  return {
    ok: true,
    wyckoff,
    vsa,
  };
}

async function main() {
  const result = runLunaWyckoffVsaSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna wyckoff/vsa smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna wyckoff-vsa smoke 실패:',
  });
}
