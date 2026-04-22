#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { diagnoseWeeklyPerformance } = require('../lib/performance-diagnostician.ts');
const { buildMarketingDigest } = require('../lib/marketing-digest.ts');
const { evolveStrategy } = require('../lib/strategy-evolver.ts');

const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');

function summarize(plan = {}, digest = {}) {
  return {
    health: digest?.health?.status || 'unknown',
    revenueImpactPct: Number(digest?.revenueCorrelation?.revenueImpactPct || 0),
    snapshotWatchCount: Number(digest?.snapshotTrend?.watchCount || 0),
    preferredCategory: plan?.preferredCategory || null,
    preferredTitlePattern: plan?.preferredTitlePattern || null,
    focus: Array.isArray(plan?.focus) ? plan.focus : [],
    recommendations: Array.isArray(plan?.recommendations) ? plan.recommendations : [],
    executionDirectives: plan?.executionDirectives || {},
  };
}

async function main() {
  const [diagnosis, marketingDigest] = await Promise.all([
    diagnoseWeeklyPerformance(7),
    buildMarketingDigest({
      revenueWindow: 14,
      diagnosisWindow: 7,
      autonomyWindow: 14,
      snapshotWindow: 7,
    }),
  ]);

  const evolution = await evolveStrategy(diagnosis, {
    dryRun,
    marketingDigest,
  });

  const payload = {
    dryRun,
    diagnosis,
    marketingDigest,
    evolution,
    summary: summarize(evolution?.plan, marketingDigest),
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[revenue-strategy] dryRun=${dryRun} health=${payload.summary.health}`);
  console.log(`[revenue-strategy] preferred category=${payload.summary.preferredCategory || 'none'} / preferred title pattern=${payload.summary.preferredTitlePattern || 'none'}`);
  console.log(`[revenue-strategy] revenue impact=${(payload.summary.revenueImpactPct * 100).toFixed(1)}% / snapshot watch=${payload.summary.snapshotWatchCount}`);
  if (payload.summary.focus.length) {
    console.log(`[revenue-strategy] focus=${payload.summary.focus.join(' | ')}`);
  }
}

main().catch((error) => {
  console.error('[revenue-strategy] 실패:', error?.stack || error?.message || String(error));
  process.exit(1);
});
