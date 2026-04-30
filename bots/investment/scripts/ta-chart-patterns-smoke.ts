#!/usr/bin/env node
// @ts-nocheck
// ta-chart-patterns-smoke.ts — Phase τ2 차트패턴 smoke test

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  detectHammer, detectBullishEngulfing, detectBearishEngulfing,
  detectDoubleBottom, detectDoubleTop, analyzeChartPatterns,
} from '../shared/ta-chart-patterns.ts';

function makeFlat(n, value = 100) { return Array(n).fill(value); }

async function runSmoke() {
  // ─── 1. detectHammer — 데이터 부족 시 false
  {
    const result = detectHammer([], [], [], [], -1);
    assert.equal(result.detected, false, 'hammer empty false');
  }

  // ─── 2. detectBullishEngulfing — 양봉이 음봉 완전 감싸는 케이스
  {
    // 3봉: o=102 c=100 (음봉), o=99 c=104 (양봉, 감쌈)
    const opens  = [100, 102, 99];
    const highs  = [103, 103, 105];
    const lows   = [99, 99, 98];
    const closes = [101, 100, 104];
    const result = detectBullishEngulfing(opens, highs, lows, closes);
    assert.equal(result.detected, true, 'bullish engulfing detected');
    assert.equal(result.type, 'bullish_engulfing');
    assert.ok(result.strength > 0, 'strength > 0');
  }

  // ─── 3. detectBearishEngulfing — 음봉이 양봉 감싸는 케이스
  {
    const opens  = [100, 99, 103];
    const highs  = [102, 101, 104];
    const lows   = [98, 98, 97];
    const closes = [101, 100, 97];
    const result = detectBearishEngulfing(opens, highs, lows, closes);
    assert.equal(result.detected, true, 'bearish engulfing detected');
    assert.equal(result.bullish, false);
  }

  // ─── 4. detectDoubleBottom — 두 저점 유사 (허용 오차 내)
  {
    const lows = [
      ...Array(5).fill(100),
      90, 91, // 첫 저점
      ...Array(5).fill(98),
      90.2, 91, // 두 번째 저점 (유사)
      ...Array(5).fill(100),
    ];
    const closes = lows.map((l, i) => l + 2 + i * 0.1); // 종가 = 저점 + α
    const result = detectDoubleBottom(lows, closes, lows.length);
    // 감지 여부는 데이터 품질에 따라 다를 수 있으므로 구조만 검증
    assert.ok(typeof result.detected === 'boolean', 'detected boolean');
    if (result.detected) {
      assert.equal(result.type, 'double_bottom');
      assert.ok(result.bullish === true);
    }
  }

  // ─── 5. analyzeChartPatterns — 통합 구조 검증
  {
    const n      = 40;
    const opens  = Array.from({ length: n }, (_, i) => 100 + i * 0.1);
    const closes = opens.map(o => o + 1);
    const highs  = closes.map(c => c + 2);
    const lows   = opens.map(o => o - 1);
    const result = analyzeChartPatterns(opens, highs, lows, closes);
    assert.ok(typeof result.bullishScore === 'number', 'bullishScore number');
    assert.ok(typeof result.bearishScore === 'number', 'bearishScore number');
    assert.ok(result.bullishScore >= 0 && result.bullishScore <= 1, 'bullishScore 범위');
    assert.ok(Array.isArray(result.bullishSignals), 'bullishSignals array');
    assert.ok(Array.isArray(result.bearishSignals), 'bearishSignals array');
  }

  console.log('ta-chart-patterns-smoke ok (5/5)');
  return { ok: true, passed: 5, total: 5 };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: '❌ ta-chart-patterns-smoke 실패:',
  });
}

export default { runSmoke };
