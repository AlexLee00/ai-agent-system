#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  adjustCommunitySourceQuality,
  buildLunaCommunitySourceQualityAudit,
  scoreCommunitySourceQuality,
} from '../shared/luna-community-source-quality.ts';

function runSmoke() {
  const rows = [
    {
      source_name: 'clean_rss',
      market: 'crypto',
      event_count: 12,
      symbol_event_count: 10,
      avg_source_quality: 0.42,
      avg_freshness: 0.92,
      avg_bot_noise: 0.03,
      hype_spike_rate: 0.02,
      missing_error_rate: 0,
      predictive_fire_rate: 0.66,
      backtest_pass_rate: 0.72,
    },
    {
      source_name: 'noisy_social',
      market: 'crypto',
      event_count: 9,
      symbol_event_count: 9,
      avg_source_quality: 0.40,
      avg_freshness: 0.55,
      avg_bot_noise: 0.76,
      hype_spike_rate: 0.55,
      missing_error_rate: 0.05,
      predictive_fire_rate: 0.08,
      backtest_pass_rate: 0.1,
    },
    {
      source_name: 'new_market_feed',
      market: 'domestic',
      event_count: 1,
      symbol_event_count: 0,
      avg_source_quality: 0.41,
      avg_freshness: 0.80,
      avg_bot_noise: 0,
      hype_spike_rate: 0,
      missing_error_rate: 0,
    },
    {
      source_name: 'cryptopanic_news',
      market: 'crypto',
      event_count: 10,
      symbol_event_count: 0,
      avg_source_quality: 0.5,
      avg_freshness: 1,
      avg_bot_noise: 0,
      hype_spike_rate: 0,
      missing_error_rate: 1,
    },
  ];

  const clean = scoreCommunitySourceQuality(rows[0], { minEvents: 3 });
  const noisy = scoreCommunitySourceQuality(rows[1], { minEvents: 3 });
  const freshButSmall = scoreCommunitySourceQuality(rows[2], { minEvents: 3 });
  assert.equal(clean.status, 'boost');
  assert.equal(noisy.status, 'block_candidate');
  assert.equal(freshButSmall.status, 'downweight');
  assert.ok(freshButSmall.reasons.includes('insufficient_sample'));

  const audit = buildLunaCommunitySourceQualityAudit({ rows, days: 7, minEvents: 3 });
  assert.equal(audit.ok, true);
  assert.equal(audit.totalSources, 3);
  assert.equal(audit.sources.some((source) => source.sourceName === 'cryptopanic_news'), false);
  assert.equal(audit.markets.length, 2);
  assert.ok(audit.overrides['community|noisy_social|crypto']);

  const adjusted = adjustCommunitySourceQuality({
    sourceType: 'community',
    sourceName: 'noisy_social',
    market: 'crypto',
    sourceQuality: 0.40,
  }, audit.overrides);
  assert.equal(adjusted.applied, true);
  assert.ok(adjusted.sourceQuality <= 0.12);

  return {
    smoke: 'luna-community-source-quality',
    ok: true,
    cleanStatus: clean.status,
    noisyStatus: noisy.status,
    adjustedNoisyQuality: adjusted.sourceQuality,
    marketCoverage: audit.markets,
  };
}

const result = runSmoke();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log('luna-community-source-quality-smoke ok');
