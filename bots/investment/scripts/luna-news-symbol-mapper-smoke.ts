#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { mapNewsToSymbols } from '../team/discovery/news-to-symbol-mapper.ts';

export async function runLunaNewsSymbolMapperSmoke() {
  const events = [
    { headline: 'NVIDIA earnings beat and guidance raised', source: 'test' },
    { headline: 'SEC investigates unknown token ecosystem issue', source: 'test' },
    { headline: 'Bitcoin ETF inflow surges after CPI data', source: 'test' },
  ];
  const overseas = await mapNewsToSymbols(events, 'overseas');
  const crypto = await mapNewsToSymbols(events, 'crypto');

  assert.ok(overseas.mapped.length >= 1);
  assert.ok(crypto.mapped.length >= 1);
  assert.ok(overseas.mapped.some((row) => row.symbol === 'NVDA'));
  assert.ok(crypto.mapped.some((row) => row.symbol === 'BTC/USDT'));
  assert.ok(overseas.unmapped.length >= 1);

  return {
    ok: true,
    overseasMapped: overseas.mapped.length,
    overseasUnmapped: overseas.unmapped.length,
    cryptoMapped: crypto.mapped.length,
    sample: {
      overseas: overseas.mapped[0] || null,
      crypto: crypto.mapped[0] || null,
    },
  };
}

async function main() {
  const result = await runLunaNewsSymbolMapperSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna news symbol mapper smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna news-symbol mapper smoke 실패:',
  });
}
