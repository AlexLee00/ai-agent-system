#!/usr/bin/env node
// @ts-nocheck
// ta-support-resistance-smoke.ts — Phase τ2 지지/저항선 smoke test

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  calcPivotPoints, calcFibonacciRetracement, findSupportLevels, findResistanceLevels,
  isPriceNearLevel, analyzeSupportResistance,
} from '../shared/ta-support-resistance.ts';

async function runSmoke() {
  // ─── 1. calcPivotPoints — 기본 피벗 계산
  {
    const pivots = calcPivotPoints(110, 90, 100);
    assert.ok(pivots, 'pivots 존재');
    assert.ok(Math.abs(pivots.pp - 100) < 0.01, `PP = (110+90+100)/3 ≈ 100: ${pivots.pp}`);
    assert.ok(pivots.r1 > pivots.pp, `R1 > PP: ${pivots.r1} > ${pivots.pp}`);
    assert.ok(pivots.s1 < pivots.pp, `S1 < PP: ${pivots.s1} < ${pivots.pp}`);
    assert.ok(pivots.r2 > pivots.r1, 'R2 > R1');
    assert.ok(pivots.s2 < pivots.s1, 'S2 < S1');
  }

  // ─── 2. calcFibonacciRetracement — 피보나치 레벨
  {
    const fib = calcFibonacciRetracement(200, 100);
    assert.ok(fib, 'fib 존재');
    assert.equal(fib.level_0, 100, 'level_0 = swingLow');
    assert.equal(fib.level_100, 200, 'level_100 = swingHigh');
    assert.ok(Math.abs(fib.level_618 - 161.8) < 0.2, `level_618 ≈ 161.8: ${fib.level_618}`);
    assert.ok(fib.level_236 > fib.level_0 && fib.level_236 < fib.level_100, '236 사이 범위');
  }

  // ─── 3. findSupportLevels — 클러스터 지지선
  {
    // 100 근처에 여러 번 터치 → 지지선으로 인식
    const closes = [
      ...Array(10).fill(110), 100.1, 100, 99.9, 100.2,
      ...Array(5).fill(108), 100, 100.3, 99.8,
      ...Array(5).fill(115),
    ];
    const supports = findSupportLevels(closes, 100);
    assert.ok(Array.isArray(supports), '배열 반환');
    // 지지선은 현재가(115) 아래여야 함
    for (const s of supports) {
      assert.ok(s.level < closes[closes.length - 1], `지지선 < 현재가: ${s.level}`);
      assert.ok(s.strength >= 0 && s.strength <= 1, 'strength 범위');
    }
  }

  // ─── 4. isPriceNearLevel — 근접 판단
  {
    assert.equal(isPriceNearLevel(100, 101, 0.02), true, '1% 이내 → near');
    assert.equal(isPriceNearLevel(100, 105, 0.02), false, '5% → not near');
    assert.equal(isPriceNearLevel(0, 100, 0.02), false, 'price=0 → false');
  }

  // ─── 5. analyzeSupportResistance — 통합 구조
  {
    const n      = 60;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 0.3) * 5);
    const highs  = closes.map(c => c + 2);
    const lows   = closes.map(c => c - 2);
    const result = analyzeSupportResistance(highs, lows, closes);
    assert.ok(Array.isArray(result.supports), 'supports 배열');
    assert.ok(Array.isArray(result.resistances), 'resistances 배열');
    assert.ok(typeof result.atSupport === 'boolean', 'atSupport boolean');
    assert.ok(typeof result.atResistance === 'boolean', 'atResistance boolean');
  }

  console.log('ta-support-resistance-smoke ok (5/5)');
  return { ok: true, passed: 5, total: 5 };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: '❌ ta-support-resistance-smoke 실패:',
  });
}

export default { runSmoke };
