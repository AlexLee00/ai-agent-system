#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildCandidate,
  buildDecision,
  summarizeSignals,
  summarizeTrades,
} from './runtime-kis-overseas-autotune-report.ts';

function config() {
  return {
    luna: {
      minConfidence: { live: { kis_overseas: 0.22 } },
      stockOrderDefaults: { kis_overseas: { min: 250 } },
    },
  };
}

export function runRuntimeKisOverseasAutotuneSmoke() {
  const operationalSignals = summarizeSignals([
    { status: 'failed', block_code: 'sec015_overseas_nemesis_bypass_guard', cnt: 24 },
  ]);
  const trades = summarizeTrades([]);
  const operationalCandidate = buildCandidate(config(), operationalSignals);
  const operationalDecision = buildDecision(operationalSignals, trades, operationalCandidate);

  assert.equal(operationalCandidate, null);
  assert.equal(operationalSignals.operationalBlockCount, 24);
  assert.equal(operationalSignals.topOperationalBlock.code, 'sec015_overseas_nemesis_bypass_guard');
  assert.equal(operationalDecision.status, 'kis_overseas_operational_blocker_attention');
  assert.match(operationalDecision.actionItems.join(' '), /nemesis_verdict|approved_at|승인 메타/);

  const thresholdSignals = summarizeSignals([
    { status: 'executed', block_code: 'none', cnt: 3 },
    { status: 'failed', block_code: 'min_order_notional', cnt: 6 },
  ]);
  const thresholdCandidate = buildCandidate(config(), thresholdSignals);
  const thresholdDecision = buildDecision(thresholdSignals, trades, thresholdCandidate);

  assert.equal(thresholdCandidate?.key, 'runtime_config.luna.stockOrderDefaults.kis_overseas.min');
  assert.equal(thresholdDecision.status, 'kis_overseas_autotune_ready');

  return {
    ok: true,
    operationalStatus: operationalDecision.status,
    thresholdStatus: thresholdDecision.status,
  };
}

async function main() {
  const result = runRuntimeKisOverseasAutotuneSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime kis overseas autotune smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime kis overseas autotune smoke 실패:',
  });
}
