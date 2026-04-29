#!/usr/bin/env node
// @ts-nocheck

import { ANALYST_TYPES } from '../shared/signal.ts';
import * as legacy from '../team/luna.ts';
import * as policy from '../shared/luna-decision-policy.ts';

const sampleAnalyses = [
  { analyst: ANALYST_TYPES.TA_MTF, signal: 'BUY', confidence: 0.72 },
  { analyst: ANALYST_TYPES.ONCHAIN, signal: 'BUY', confidence: 0.66 },
  {
    analyst: ANALYST_TYPES.SENTINEL,
    signal: 'HOLD',
    confidence: 0.52,
    metadata: {
      quality: { status: 'healthy' },
      sourceBreakdown: {
        news: { signal: 'BUY', confidence: 0.61 },
        community: { signal: 'HOLD', confidence: 0.44 },
      },
    },
  },
];

const checks = [
  ['buildAnalystWeights', JSON.stringify(legacy.buildAnalystWeights('binance')) === JSON.stringify(policy.buildAnalystWeights('binance'))],
  ['getMinConfidence', legacy.getMinConfidence('binance') === policy.getMinConfidence('binance')],
  ['getDebateLimit', legacy.getDebateLimit('binance', 30) === policy.getDebateLimit('binance', 30)],
  ['shouldDebateForSymbol', legacy.shouldDebateForSymbol(sampleAnalyses, 'binance') === policy.shouldDebateForSymbol(sampleAnalyses, 'binance')],
  ['fuseSignals', JSON.stringify(legacy.fuseSignals(sampleAnalyses)) === JSON.stringify(policy.fuseSignals(sampleAnalyses))],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(`luna decision policy mismatch: ${failed.map(([name]) => name).join(', ')}`);
}

const payload = {
  ok: true,
  smoke: 'luna-decision-policy',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ luna decision policy smoke passed');
}
