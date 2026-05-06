#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runDiscoveryOrchestrator } from '../team/discovery/discovery-orchestrator.ts';
import { buildDiscoveryUniverse, normalizeDiscoverySymbol, toDiscoveryMarket } from '../team/discovery/discovery-universe.ts';
import * as db from '../shared/db.ts';
import {
  ensureCandidateUniverseTable,
  getActiveCandidates,
  normalizeLegacyCryptoCandidateSymbols,
} from '../team/discovery/discovery-store.ts';
import { BinanceMarketMomentumCollector } from '../team/discovery/crypto/binance-market-momentum.ts';
import { CoinGeckoTrendingCollector } from '../team/discovery/crypto/coingecko-trending.ts';

export async function runLunaDiscoveryUniverseSmoke() {
  const market = toDiscoveryMarket('binance');
  assert.equal(market, 'crypto');
  assert.equal(normalizeDiscoverySymbol('BTCUSDT', 'crypto'), 'BTC/USDT');
  assert.equal(normalizeDiscoverySymbol('005930', 'domestic'), '005930');

  const baseUniverse = await buildDiscoveryUniverse('crypto', new Date(), {
    refresh: false,
    fallbackSymbols: ['BTC/USDT', 'ETH/USDT'],
    limit: 40,
  });
  assert.ok(Array.isArray(baseUniverse.symbols));
  assert.ok(baseUniverse.symbols.includes('BTC/USDT'));

  const prev = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'true';
  const dryRun = await runDiscoveryOrchestrator({
    dryRun: true,
    skipDbWrite: true,
    markets: ['crypto', 'domestic', 'overseas'],
    limit: 10,
  });
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = prev;

  assert.ok(Number(dryRun?.stats?.totalAdapters || 0) >= 3);
  assert.ok(Number(dryRun?.stats?.successCount || 0) >= 1);
  const cryptoSources = (dryRun?.markets?.crypto || []).map((item) => item.source);
  assert.ok(cryptoSources.includes('binance_market_momentum'));
  assert.ok(cryptoSources.includes('coingecko_trending'));

  const binanceCollector = new BinanceMarketMomentumCollector();
  const coingeckoCollector = new CoinGeckoTrendingCollector();
  assert.ok(binanceCollector.reliability > coingeckoCollector.reliability);
  assert.ok(binanceCollector.reliability >= 0.9);
  const binanceDryRun = await binanceCollector.collect({ dryRun: true, limit: 10 });
  assert.equal(binanceDryRun.source, 'binance_market_momentum');
  assert.ok(binanceDryRun.signals.length >= 3);
  assert.equal(binanceDryRun.signals.some((signal) => /(?:USDC|USD1|FDUSD)\/USDT/.test(signal.symbol)), false);

  await ensureCandidateUniverseTable();
  const smokeSource = `smoke_crypto_normalize_${Date.now()}`;
  try {
    await db.run(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason, ttl_hours, raw_data, expires_at)
       VALUES
         ('BTCUSDT', 'crypto', $1, 1, 0.7000, 0.70, 'legacy raw smoke', 1, '{}'::jsonb, now() + interval '1 hour'),
         ('BTC/USDT', 'crypto', $1, 1, 0.6500, 0.65, 'canonical smoke', 1, '{}'::jsonb, now() + interval '1 hour')`,
      [smokeSource],
    );
    const normalized = await normalizeLegacyCryptoCandidateSymbols();
    const rows = await db.query(
      `SELECT symbol, score::float AS score, reason
       FROM candidate_universe
       WHERE market = 'crypto' AND source = $1
       ORDER BY symbol`,
      [smokeSource],
    );
    assert.ok(normalized >= 1);
    assert.deepEqual(rows.map((row) => row.symbol), ['BTC/USDT']);
    assert.equal(Number(rows[0]?.score || 0), 0.7);
    assert.equal(rows[0]?.reason, 'legacy raw smoke');
    const active = await getActiveCandidates('crypto', 20);
    assert.equal(active.some((row) => row.symbol === 'BTCUSDT'), false);
    await db.run(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason, ttl_hours, raw_data, expires_at)
       VALUES
         ('SMOKEMOMENTUM/USDT', 'crypto', 'coingecko_trending', 1, 0.9500, 0.95, 'coingecko high score smoke', 1, '{}'::jsonb, now() + interval '1 hour'),
         ('SMOKEMOMENTUM/USDT', 'crypto', 'binance_market_momentum', 1, 0.7000, 0.92, 'binance trusted source smoke', 1, '{}'::jsonb, now() + interval '1 hour')`,
    );
    const trusted = await getActiveCandidates('crypto', 200);
    const smokeMomentum = trusted.find((row) => row.symbol === 'SMOKEMOMENTUM/USDT');
    assert.equal(smokeMomentum?.source, 'binance_market_momentum');
  } finally {
    await db.run(`DELETE FROM candidate_universe WHERE source = $1 OR symbol = 'SMOKEMOMENTUM/USDT'`, [smokeSource]).catch(() => null);
  }

  return {
    ok: true,
    market,
    universeSource: baseUniverse.source,
    symbolCount: baseUniverse.symbols.length,
    orchestratorStats: dryRun.stats,
  };
}

async function main() {
  const result = await runLunaDiscoveryUniverseSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna discovery universe smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna discovery universe smoke 실패:',
  });
}
