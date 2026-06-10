#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { __test as lunaTest } from '../team/luna.ts';

const { buildReviewConfidenceHint } = lunaTest;

function deltaFor(insight) {
  return buildReviewConfidenceHint(insight).delta;
}

assert.equal(deltaFor(null), 0, 'null insight should be neutral');
assert.equal(deltaFor({ closedTrades: 29, winRate: 0.9, avgPnlPercent: 10 }), 0, '29 trades should stay neutral');
assert.equal(deltaFor({ closedTrades: 30, winRate: 0.7, avgPnlPercent: 1.2 }), 0.025, '30 trades + 70% win rate should apply half-strength boost');
assert.equal(deltaFor({ closedTrades: 30, winRate: 0.3, avgPnlPercent: 1.2 }), -0.04, '30 trades + 30% win rate should apply half-strength penalty');

const scenarios = [
  { name: 'S1 insufficient sample high win', insight: { closedTrades: 3, winRate: 1, avgPnlPercent: 5 }, expected: 0 },
  { name: 'S2 exactly min neutral', insight: { closedTrades: 30, winRate: 0.5, avgPnlPercent: 0 }, expected: 0 },
  { name: 'S3 high win boost', insight: { closedTrades: 45, winRate: 0.65, avgPnlPercent: 0 }, expected: 0.025 },
  { name: 'S4 low win penalty', insight: { closedTrades: 45, winRate: 0.39, avgPnlPercent: 0 }, expected: -0.04 },
  { name: 'S5 negative pnl penalty', insight: { closedTrades: 45, winRate: 0.5, avgPnlPercent: -0.01 }, expected: -0.025 },
  { name: 'S6 low win plus negative pnl penalty', insight: { closedTrades: 45, winRate: 0.3, avgPnlPercent: -2.5 }, expected: -0.065 },
];

for (const scenario of scenarios) {
  assert.equal(deltaFor(scenario.insight), scenario.expected, scenario.name);
}

console.log('[luna-p0-review-hint-smoke] PASS');
