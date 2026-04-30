#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDiscoveryUniverse } from '../team/discovery/discovery-universe.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';

async function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    prev[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function makeCryptoSymbols(count) {
  return Array.from({ length: count }, (_, i) => `TEST${i + 1}USDT`);
}

function makeDomesticSymbols(count) {
  return Array.from({ length: count }, (_, i) => String(100000 + i).slice(0, 6));
}

function makeOverseasSymbols(count) {
  return Array.from({ length: count }, (_, i) => `TST${i + 1}`);
}

export async function runDiscoveryTopNSmoke() {
  return withEnv({
    LUNA_DISCOVERY_TOP_DOMESTIC: 7,
    LUNA_DISCOVERY_TOP_OVERSEAS: 6,
    LUNA_DISCOVERY_TOP_CRYPTO: 5,
  }, async () => {
    const flags = getLunaIntelligentDiscoveryFlags();
    assert.equal(flags.discovery.topDomestic, 7);
    assert.equal(flags.discovery.topOverseas, 6);
    assert.equal(flags.discovery.topCrypto, 5);

    const crypto = await buildDiscoveryUniverse('crypto', new Date('2026-01-01T00:00:00Z'), {
      refresh: false,
      fallbackSymbols: makeCryptoSymbols(20),
    });
    const domestic = await buildDiscoveryUniverse('domestic', new Date('2026-01-01T00:00:00Z'), {
      refresh: false,
      fallbackSymbols: makeDomesticSymbols(20),
    });
    const overseas = await buildDiscoveryUniverse('overseas', new Date('2026-01-01T00:00:00Z'), {
      refresh: false,
      fallbackSymbols: makeOverseasSymbols(20),
    });

    assert.equal(crypto.limit, 5);
    assert.equal(domestic.limit, 7);
    assert.equal(overseas.limit, 6);
    assert.ok(crypto.symbols.length <= 5);
    assert.ok(domestic.symbols.length <= 7);
    assert.ok(overseas.symbols.length <= 6);

    return {
      ok: true,
      topN: {
        domestic: domestic.limit,
        overseas: overseas.limit,
        crypto: crypto.limit,
      },
      counts: {
        domestic: domestic.symbols.length,
        overseas: overseas.symbols.length,
        crypto: crypto.symbols.length,
      },
    };
  });
}

async function main() {
  const result = await runDiscoveryTopNSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('discovery-top-n-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ discovery-top-n-smoke 실패:' });
}
