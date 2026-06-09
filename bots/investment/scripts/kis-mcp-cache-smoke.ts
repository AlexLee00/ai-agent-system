#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { _testOnlyKisClient } from '../shared/kis-client.ts';

export async function runKisMcpCacheSmoke() {
  const originalEnv = {
    KIS_MCP_BALANCE_CACHE_TTL_MS: process.env.KIS_MCP_BALANCE_CACHE_TTL_MS,
    KIS_MCP_BALANCE_STALE_MS: process.env.KIS_MCP_BALANCE_STALE_MS,
  };
  try {
    process.env.KIS_MCP_BALANCE_CACHE_TTL_MS = '60000';
    process.env.KIS_MCP_BALANCE_STALE_MS = '600000';

    _testOnlyKisClient.clearKisMcpResponseCache();

    const payloadA = { paper: false, market: 'domestic' };
    const payloadB = { market: 'domestic', paper: false };
    assert.equal(
      _testOnlyKisClient.kisMcpCacheKey('domestic_balance', payloadA),
      _testOnlyKisClient.kisMcpCacheKey('domestic_balance', payloadB),
      'KIS MCP cache key should be stable regardless of object key order',
    );

    _testOnlyKisClient.setKisMcpCachedResponse('domestic_balance', payloadA, {
      status: 'ok',
      balance: { holdings: [{ symbol: '005930', qty: 1 }] },
    });

    const cached = _testOnlyKisClient.getKisMcpCachedResponse('domestic_balance', payloadB, 'fresh');
    assert.equal(cached.status, 'ok');
    assert.equal(cached.balance.holdings[0].symbol, '005930');
    assert.equal(cached.cache.hit, true);
    assert.equal(cached.cache.stale, false);

    const stale = _testOnlyKisClient.getKisMcpCachedResponse('domestic_balance', payloadB, 'stale');
    assert.equal(stale.status, 'ok');
    assert.equal(stale.cache.hit, true);

    assert.equal(
      _testOnlyKisClient.isKisProviderLimitMessage('KIS API 오류 [APBK1350]: 조회 오류입니다. 다시 조회 하세요.'),
      true,
      'APBK1350 read-only lookup errors should use KIS MCP cooldown/stale cache path',
    );

    return { ok: true, cacheKey: _testOnlyKisClient.kisMcpCacheKey('domestic_balance', payloadA) };
  } finally {
    _testOnlyKisClient.clearKisMcpResponseCache();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const result = await runKisMcpCacheSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('kis mcp cache smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ kis mcp cache smoke 실패:',
  });
}
