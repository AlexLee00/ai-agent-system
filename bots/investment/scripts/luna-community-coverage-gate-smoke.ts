#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLunaCommunityCoverageGate,
  evaluateCommunityCoverageMarket,
} from '../shared/luna-community-coverage-gate.ts';

function runSmoke() {
  const passingRows = [
    {
      market: 'crypto',
      event_count: 32,
      unique_source_count: 6,
      avg_freshness: 0.88,
      avg_source_quality: 0.39,
      missing_error_rate: 0.02,
      bot_noise_rate: 0.05,
      hype_spike_rate: 0.08,
      symbol_count: 9,
    },
    {
      market: 'domestic',
      event_count: 14,
      unique_source_count: 4,
      avg_freshness: 0.72,
      avg_source_quality: 0.37,
      missing_error_rate: 0.08,
      bot_noise_rate: 0.04,
      hype_spike_rate: 0.10,
      symbol_count: 5,
    },
    {
      market: 'overseas',
      event_count: 16,
      unique_source_count: 4,
      avg_freshness: 0.69,
      avg_source_quality: 0.38,
      missing_error_rate: 0.04,
      bot_noise_rate: 0.06,
      hype_spike_rate: 0.09,
      symbol_count: 6,
    },
  ];
  const pass = buildLunaCommunityCoverageGate({ rows: passingRows, hours: 24 });
  assert.equal(pass.ok, true);
  assert.equal(pass.summary.passMarkets, 3);

  const weakCrypto = evaluateCommunityCoverageMarket({
    market: 'crypto',
    event_count: 8,
    unique_source_count: 2,
    avg_freshness: 0.42,
    missing_error_rate: 0.40,
    bot_noise_rate: 0.45,
    hype_spike_rate: 0.50,
  });
  assert.equal(weakCrypto.pass, false);
  assert.ok(weakCrypto.blockers.includes('events<20'));
  assert.ok(weakCrypto.blockers.includes('sources<4'));
  assert.ok(weakCrypto.blockers.includes('freshness<0.5'));
  assert.ok(weakCrypto.blockers.includes('missing_error>0.35'));

  const missingMarket = buildLunaCommunityCoverageGate({ rows: passingRows.slice(0, 2), hours: 24 });
  assert.equal(missingMarket.ok, false);
  assert.ok(missingMarket.blockers.some((blocker) => blocker.startsWith('community_coverage_gate_failed:overseas:')));

  const marketwideMapped = evaluateCommunityCoverageMarket({
    market: 'domestic',
    event_count: 12,
    unique_source_count: 3,
    avg_freshness: 0.71,
    avg_source_quality: 0.36,
    missing_error_rate: 0,
    bot_noise_rate: 0,
    hype_spike_rate: 0,
    symbol_count: 0,
    seed_candidate_count: 4,
  });
  assert.equal(marketwideMapped.pass, true);
  assert.equal(marketwideMapped.warnings.includes('marketwide_only_or_unmapped_symbols'), false);

  return {
    smoke: 'luna-community-coverage-gate',
    ok: true,
    passingMarkets: pass.summary.passMarkets,
    weakCryptoBlockers: weakCrypto.blockers,
    missingMarketBlockers: missingMarket.blockers,
  };
}

const result = runSmoke();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log('luna-community-coverage-gate-smoke ok');
