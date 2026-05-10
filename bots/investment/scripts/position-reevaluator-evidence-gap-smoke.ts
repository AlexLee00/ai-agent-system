#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildEvidenceGapTaskQueueInput } from '../shared/position-reevaluator.ts';

export function runPositionReevaluatorEvidenceGapSmoke() {
  const chartBacked = buildEvidenceGapTaskQueueInput({
    position: { symbol: 'BTC/USDT', exchange: 'binance' },
    tradeMode: 'normal',
    externalEvidenceSummary: {
      evidenceCount: 0,
      warning: '최근 외부 에비던스 없음',
    },
    entryEvidenceCarryover: { usedCarryover: false },
    indicatorAnalyses: [
      { signal: 'HOLD', snapshot: { interval: '1h', close: 80772 } },
      { signal: 'HOLD', snapshot: { interval: '4h', close: 80752 } },
      { signal: 'SELL', snapshot: { interval: '1d', close: 80752 } },
    ],
  });
  assert.equal(chartBacked.evidenceCount, 3);
  assert.equal(chartBacked.reason, 'chart_indicator_evidence_available:3');
  assert.deepEqual(chartBacked.evidenceBreakdown, {
    externalEvidenceCount: 0,
    chartEvidenceCount: 3,
  });

  const externalBacked = buildEvidenceGapTaskQueueInput({
    position: { symbol: 'PSG/USDT', exchange: 'binance' },
    externalEvidenceSummary: {
      evidenceCount: 2,
      warning: null,
    },
    entryEvidenceCarryover: { usedCarryover: false },
    indicatorAnalyses: [
      { signal: 'HOLD', snapshot: { interval: '1h', close: 1.02 } },
    ],
  });
  assert.equal(externalBacked.evidenceCount, 2);
  assert.equal(externalBacked.reason, null);

  const realGap = buildEvidenceGapTaskQueueInput({
    position: { symbol: 'UTK/USDT', exchange: 'binance' },
    externalEvidenceSummary: {
      evidenceCount: 0,
      warning: 'no evidence',
    },
    entryEvidenceCarryover: { usedCarryover: false },
    indicatorAnalyses: [],
  });
  assert.equal(realGap.evidenceCount, 0);
  assert.equal(realGap.reason, 'no evidence');

  return {
    ok: true,
    chartBacked,
    externalBacked,
    realGap,
  };
}

if (isDirectExecution(import.meta.url)) {
  void runCliMain({
    run: () => {
      const result = runPositionReevaluatorEvidenceGapSmoke();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log('position reevaluator evidence gap smoke ok');
    },
    errorPrefix: '❌ position-reevaluator-evidence-gap-smoke 실패:',
  });
}

