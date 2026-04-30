#!/usr/bin/env node
// @ts-nocheck
// ta-ma-cross-detector-smoke.ts — Phase τ3 MA 교차 smoke test

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { detectMaCrossover, getActiveCrossSignals, summarizeCrossSignals } from '../shared/ta-ma-cross-detector.ts';

// 상승 추세 데이터: MA5 > MA20
function makeUptrend(n = 60) {
  return Array.from({ length: n }, (_, i) => 100 + i * 0.5);
}

// 하락 추세 데이터: MA5 < MA20
function makeDowntrend(n = 60) {
  return Array.from({ length: n }, (_, i) => 130 - i * 0.5);
}

// 골든크로스 시나리오: 처음엔 하락, 이후 상승
function makeGoldenCross(n = 60) {
  return [
    ...Array.from({ length: 30 }, (_, i) => 100 - i * 0.3), // 하락
    ...Array.from({ length: 30 }, (_, i) => 91 + i * 0.8),  // 상승
  ].slice(0, n);
}

async function runSmoke() {
  // ─── 1. detectMaCrossover — 데이터 부족 시 none
  {
    const result = detectMaCrossover([100, 101], 5, 20);
    assert.equal(result.type, 'none', '데이터 부족 → none');
    assert.equal(result.confirmed, false);
  }

  // ─── 2. detectMaCrossover — 상승 추세에서 골든크로스 상태
  {
    const closes = makeUptrend(60);
    const result = detectMaCrossover(closes, 5, 20);
    assert.equal(result.type, 'golden_cross', `상승 추세 → golden_cross: ${result.type}`);
    assert.ok(result.strength >= 0 && result.strength <= 1, `strength 범위: ${result.strength}`);
    assert.equal(result.fastPeriod, 5);
    assert.equal(result.slowPeriod, 20);
  }

  // ─── 3. detectMaCrossover — 하락 추세에서 데드크로스 상태
  {
    const closes = makeDowntrend(60);
    const result = detectMaCrossover(closes, 5, 20);
    assert.equal(result.type, 'death_cross', `하락 추세 → death_cross: ${result.type}`);
  }

  // ─── 4. getActiveCrossSignals — 3개 쌍 반환
  {
    const closes  = makeUptrend(220); // MA 50/200을 위해 220봉 필요
    const signals = getActiveCrossSignals(closes);
    assert.equal(signals.length, 3, '3개 신호 반환');
    const labels = signals.map(s => s.label);
    assert.ok(labels.includes('단기'), '단기 포함');
    assert.ok(labels.includes('중기'), '중기 포함');
    assert.ok(labels.includes('장기'), '장기 포함');
    for (const s of signals) {
      assert.ok(['golden_cross', 'death_cross', 'none'].includes(s.type), `type 유효: ${s.type}`);
    }
  }

  // ─── 5. summarizeCrossSignals — 요약 구조 검증
  {
    const closes  = makeUptrend(220);
    const signals = getActiveCrossSignals(closes);
    const summary = summarizeCrossSignals(signals);
    assert.ok(typeof summary.goldenCount === 'number', 'goldenCount');
    assert.ok(typeof summary.deathCount === 'number', 'deathCount');
    assert.ok(typeof summary.freshGolden === 'boolean', 'freshGolden');
    assert.ok(['bullish', 'bearish', 'neutral'].includes(summary.overallBias), `overallBias: ${summary.overallBias}`);
    assert.ok(typeof summary.summary === 'string', 'summary string');
  }

  console.log('ta-ma-cross-detector-smoke ok (5/5)');
  return { ok: true, passed: 5, total: 5 };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: '❌ ta-ma-cross-detector-smoke 실패:',
  });
}

export default { runSmoke };
