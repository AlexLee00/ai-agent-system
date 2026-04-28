#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { fuseDiscoveryScore } from '../shared/discovery-score-fusion.ts';

export function runLunaScoreFusionSafetySmoke() {
  const bull = fuseDiscoveryScore({
    regime: 'TRENDING_BULL',
    discoverySignals: [{ symbol: 'NVDA', score: 0.9 }],
    sentiment: { sentimentScore: 0.8 },
    technical: { confidence: 0.9 },
    mtf: { alignmentScore: 0.9, dominantSignal: 'BUY' },
    wyckoff: { phase: 'accumulation', confidence: 0.9 },
    vsa: { pattern: 'stopping_volume', strength: 0.8 },
  });
  const weightSum = Object.values(bull.components.weights).reduce((sum, value) => sum + Number(value || 0), 0);
  assert.ok(weightSum >= 0.99 && weightSum <= 1.01, `weight sum normalized (${weightSum})`);
  assert.ok(bull.discoveryScore <= 1);
  assert.equal(bull.setupType, 'wyckoff_accumulation');

  const distribution = fuseDiscoveryScore({
    regime: 'TRENDING_BEAR',
    discoverySignals: [{ symbol: 'POET', score: 0.7 }],
    sentiment: { sentimentScore: -0.5 },
    technical: { confidence: 0.55 },
    mtf: { alignmentScore: -0.3, dominantSignal: 'SELL' },
    wyckoff: { phase: 'distribution', confidence: 0.8 },
    vsa: { pattern: 'effort_no_result', strength: 0.5 },
  });
  assert.equal(distribution.setupType, 'avoid_long_distribution');

  return {
    ok: true,
    bull,
    distribution,
    weightSum: Number(weightSum.toFixed(4)),
  };
}

async function main() {
  const result = runLunaScoreFusionSafetySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna score fusion safety smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna score fusion safety smoke 실패:',
  });
}
