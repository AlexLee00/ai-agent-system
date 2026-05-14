#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { scoreCommunitySentiment } from '../shared/community-sentiment.ts';

export async function runLunaCommunitySentimentSmoke() {
  const empty = await scoreCommunitySentiment([], { exchange: 'binance', minutes: 60 });
  assert.deepEqual(empty, []);

  const rows = await scoreCommunitySentiment(['BTC/USDT', 'ETH/USDT'], {
    exchange: 'binance',
    minutes: 240,
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(typeof row.symbol === 'string');
    assert.ok(Number.isFinite(Number(row.sentimentScore)));
    assert.ok(Number.isFinite(Number(row.confidence)));
  }

  const externalRows = await scoreCommunitySentiment(['BTC/USDT'], {
    exchange: 'binance',
    minutes: 240,
    externalRows: [{
      symbol: 'BTC/USDT',
      source_name: 'reddit_wsb',
      signal_direction: 'bullish',
      score: 0.8,
      source_quality: 0.5,
      freshness_score: 1,
      raw_ref: { mentions: 30 },
      created_at: new Date().toISOString(),
    }],
  });
  assert.equal(externalRows.length, 1);
  assert.ok(Number(externalRows[0].sentimentScore) > 0, 'external community evidence should lift sentiment');
  assert.equal(externalRows[0].communityPolicy, 'community_as_advisory_not_standalone_buy');

  const hypeRows = await scoreCommunitySentiment(['HYPE/USDT'], {
    exchange: 'binance',
    minutes: 240,
    externalRows: [{
      symbol: 'HYPE/USDT',
      source_name: 'reddit_cryptocurrency',
      signal_direction: 'bullish',
      score: 0.95,
      source_quality: 0.5,
      freshness_score: 1,
      raw_ref: { mentions: 1200 },
      created_at: new Date().toISOString(),
    }],
  });
  assert.equal(hypeRows.length, 1);
  assert.equal(hypeRows[0].narrativeRisk, 'high');
  assert.ok(hypeRows[0].narrativeRiskReasons.includes('hype_spike_requires_confirmation'));
  assert.ok(Number(hypeRows[0].confidence) <= 0.6);

  return {
    ok: true,
    count: rows.length,
    sample: rows[0] || null,
    externalSample: externalRows[0] || null,
    hypeSample: hypeRows[0] || null,
  };
}

async function main() {
  const result = await runLunaCommunitySentimentSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna community sentiment smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna community sentiment smoke 실패:',
  });
}
