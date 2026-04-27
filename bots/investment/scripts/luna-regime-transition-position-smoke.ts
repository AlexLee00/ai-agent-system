#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRegimeAwarePolicyMatrix } from '../shared/position-runtime-state.ts';

function matrix(exchange, regime, recommendation = 'HOLD') {
  return buildRegimeAwarePolicyMatrix({
    exchange,
    strategyProfile: {
      id: `smoke-${exchange}`,
      setup_type: 'momentum_breakout',
      strategy_state: {
        lifecycleStatus: 'holding',
      },
    },
    pnlPct: 1.2,
    recommendation,
    regime: {
      regime,
      confidence: 0.78,
      capturedAt: new Date().toISOString(),
    },
    analysisSummary: {
      buy: recommendation === 'EXIT' ? 0 : 2,
      sell: recommendation === 'EXIT' ? 3 : 0,
      liveIndicator: {
        weightedBias: recommendation === 'EXIT' ? -0.55 : 0.25,
        qualityScore: 0.82,
      },
    },
    driftContext: {
      sharpeDrop: recommendation === 'EXIT' ? 1.2 : 0.1,
      returnDropPct: recommendation === 'EXIT' ? 4 : 0.5,
    },
    externalEvidenceSummary: {
      evidenceCount: 3,
      avgQuality: 0.74,
      avgFreshness: 0.8,
    },
  });
}

export function runLunaRegimeTransitionPositionSmoke() {
  const cases = [];
  for (const exchange of ['binance', 'kis', 'kis_overseas']) {
    const bull = matrix(exchange, 'trending_bull', 'HOLD');
    const bear = matrix(exchange, 'trending_bear', 'HOLD');
    const volatile = matrix(exchange, 'volatile', 'HOLD');
    const exit = matrix(exchange, 'trending_bear', 'EXIT');

    assert.ok(bull.regime === 'trending_bull', `${exchange} bull regime`);
    assert.ok(bear.regime === 'trending_bear', `${exchange} bear regime`);
    assert.ok(volatile.regime === 'volatile', `${exchange} volatile regime`);
    assert.ok(Number(bear.cadenceMs || 0) <= Number(bull.cadenceMs || Infinity), `${exchange} bear cadence should not loosen`);
    assert.equal(bear.riskGate, 'strict_risk_gate', `${exchange} bear risk gate`);
    assert.ok(['defensive', 'cautious'].includes(bear.policyMode), `${exchange} bear policy mode`);
    assert.equal(exit.reevaluationBias.recommendation, 'EXIT', `${exchange} exit recommendation preserved`);
    assert.ok(exit.riskGate, `${exchange} exit risk gate present`);

    cases.push({
      exchange,
      bull: { policyMode: bull.policyMode, cadenceMs: bull.cadenceMs, riskGate: bull.riskGate },
      bear: { policyMode: bear.policyMode, cadenceMs: bear.cadenceMs, riskGate: bear.riskGate },
      volatile: { policyMode: volatile.policyMode, cadenceMs: volatile.cadenceMs, riskGate: volatile.riskGate },
      exit: { recommendation: exit.reevaluationBias.recommendation, riskGate: exit.riskGate },
    });
  }

  return {
    ok: true,
    caseCount: cases.length,
    cases,
  };
}

async function main() {
  const result = runLunaRegimeTransitionPositionSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna regime transition position smoke ok (${result.caseCount} exchanges)`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna regime transition position smoke 실패:',
  });
}
