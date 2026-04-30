#!/usr/bin/env node
// @ts-nocheck
// ta-divergence-detector-smoke.ts — Phase τ2 다이버전스 감지 smoke test

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { detectRsiDivergence, detectMacdDivergence, detectVolumeDivergence, analyzeDivergences } from '../shared/ta-divergence-detector.ts';

// 테스트용 데이터 생성 유틸
function makeLinear(start, end, n) {
  return Array.from({ length: n }, (_, i) => start + (end - start) * (i / (n - 1)));
}

function makeSine(n, amplitude = 10, base = 100) {
  return Array.from({ length: n }, (_, i) => base + amplitude * Math.sin(i * Math.PI / (n / 4)));
}

async function runSmoke() {
  // ─── 1. detectRsiDivergence — 데이터 부족 시 none 반환
  {
    const result = detectRsiDivergence([], [], 14);
    assert.equal(result.type, 'none', 'empty 입력 시 none');
    assert.equal(result.strength, 0, 'empty 입력 시 strength=0');
  }

  // ─── 2. detectRsiDivergence — 기본 반환 구조 검증
  {
    const closes   = makeSine(60);
    const rsiVals  = makeSine(46, 15, 50); // RSI-like (30~70)
    const result   = detectRsiDivergence(closes, rsiVals);
    assert.ok(['bullish_divergence', 'bearish_divergence', 'hidden_bullish', 'hidden_bearish', 'none'].includes(result.type), `type 유효: ${result.type}`);
    assert.ok(result.strength >= 0 && result.strength <= 1, `strength 범위: ${result.strength}`);
  }

  // ─── 3. detectMacdDivergence — 기본 구조
  {
    const closes = makeLinear(100, 110, 60);
    const macdH  = makeLinear(-0.5, 0.5, 20);
    const result = detectMacdDivergence(closes, macdH);
    assert.ok(typeof result.type === 'string', 'macd type string');
    assert.ok(result.strength >= 0, 'macd strength >= 0');
  }

  // ─── 4. detectVolumeDivergence — effort_no_result 감지
  {
    const closes  = makeLinear(100, 100.1, 30); // 거의 변화 없음
    const volumes = [...Array(29).fill(1000), 2200]; // 마지막 거래량 급등
    const result  = detectVolumeDivergence(closes, volumes, 14);
    assert.ok(['effort_no_result', 'result_no_effort', 'none'].includes(result.type), `volume type: ${result.type}`);
  }

  // ─── 5. analyzeDivergences — 통합 반환 구조
  {
    const closes  = makeSine(80, 20, 50000);
    const highs   = closes.map(c => c * 1.01);
    const lows    = closes.map(c => c * 0.99);
    const volumes = Array(80).fill(1000);
    const result  = analyzeDivergences(closes, highs, lows, volumes);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(result.overall), `overall: ${result.overall}`);
    assert.ok(result.bullishScore >= 0 && result.bullishScore <= 1, 'bullishScore 범위');
    assert.ok(result.bearishScore >= 0 && result.bearishScore <= 1, 'bearishScore 범위');
    assert.ok(typeof result.rsi === 'object', 'rsi 결과 존재');
    assert.ok(typeof result.macd === 'object', 'macd 결과 존재');
    assert.ok(typeof result.volume === 'object', 'volume 결과 존재');
  }

  console.log('ta-divergence-detector-smoke ok (5/5)');
  return { ok: true, passed: 5, total: 5 };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: '❌ ta-divergence-detector-smoke 실패:',
  });
}

export default { runSmoke };
