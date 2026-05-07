#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildKisDomesticSelfTuneHistorySnapshot,
  isSameKisDomesticSelfTuneEvidence,
} from './runtime-kis-domestic-self-tune.ts';

function reportFixture({ current = 0.22, suggested = 0.2, totalBuy = 36 } = {}) {
  return {
    candidate: {
      key: 'runtime_config.luna.minConfidence.live.kis',
      current,
      suggested,
    },
    decision: {
      metrics: {
        totalBuy,
        executedSignals: 10,
        failedSignals: 26,
        normalRule1Blocks: 0,
        validationRule1Blocks: 0,
        orderPressureTotal: 3,
      },
    },
  };
}

export function runKisDomesticSelfTuneSmoke() {
  const first = reportFixture();
  const snapshot = buildKisDomesticSelfTuneHistorySnapshot(first);
  assert.equal(snapshot.candidateKey, 'runtime_config.luna.minConfidence.live.kis');

  const sameEvidenceLowerNext = reportFixture({ current: 0.2, suggested: 0.18 });
  assert.equal(isSameKisDomesticSelfTuneEvidence(sameEvidenceLowerNext, snapshot), true);

  const newEvidence = reportFixture({ current: 0.2, suggested: 0.18, totalBuy: 42 });
  assert.equal(isSameKisDomesticSelfTuneEvidence(newEvidence, snapshot), false);

  return {
    ok: true,
    smoke: 'kis-domestic-self-tune',
    sameEvidenceBlocked: true,
  };
}

async function main() {
  const result = runKisDomesticSelfTuneSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('kis-domestic-self-tune-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ kis-domestic-self-tune-smoke 실패:',
  });
}
