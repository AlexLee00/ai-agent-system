#!/usr/bin/env node
// @ts-nocheck
// ta-weighted-voting-smoke.ts — Phase τ4 가중치 투표 smoke test

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { aggregateVotes, buildVotesFromIndicators, REGIME_WEIGHTS } from '../shared/ta-weighted-voting.ts';

async function runSmoke() {
  // ─── 1. aggregateVotes — 빈 투표 시 중립
  {
    const result = aggregateVotes([], 'RANGING');
    assert.equal(result.finalVote, 0, '빈 투표 → 0');
    assert.equal(result.confidence, 0, '빈 투표 → confidence 0');
  }

  // ─── 2. aggregateVotes — 전체 매수 투표 → finalVote=1
  {
    const votes = [
      { name: 'rsi',  vote: 1, confidence: 1 },
      { name: 'macd', vote: 1, confidence: 1 },
      { name: 'bollinger', vote: 1, confidence: 1 },
    ];
    const result = aggregateVotes(votes, 'RANGING');
    assert.equal(result.finalVote, 1, '전체 매수 → 1');
    assert.ok(result.score > 0, `score > 0: ${result.score}`);
    assert.ok(result.confidence > 0, `confidence > 0: ${result.confidence}`);
    assert.ok(result.contributingIndicators.length > 0, '기여 지표 존재');
  }

  // ─── 3. aggregateVotes — 전체 매도 투표 → finalVote=-1
  {
    const votes = [
      { name: 'rsi',  vote: -1, confidence: 1 },
      { name: 'macd', vote: -1, confidence: 1 },
    ];
    const result = aggregateVotes(votes, 'TRENDING_BEAR');
    assert.equal(result.finalVote, -1, '전체 매도 → -1');
    assert.ok(result.score < 0, `score < 0: ${result.score}`);
  }

  // ─── 4. aggregateVotes — 혼재 투표 → 근중립
  {
    const votes = [
      { name: 'rsi',  vote: 1, confidence: 0.8 },
      { name: 'macd', vote: -1, confidence: 0.8 },
    ];
    const result = aggregateVotes(votes, 'RANGING');
    assert.ok(typeof result.finalVote === 'number', 'finalVote number');
    assert.ok(result.score >= -1 && result.score <= 1, `score 범위: ${result.score}`);
  }

  // ─── 5. buildVotesFromIndicators — 지표 → 투표 변환
  {
    const votes = buildVotesFromIndicators({
      rsi:          25,  // 과매도 → vote=1
      macd:         { histogram: 0.5, macd: 1, signal: 0.5 }, // 상승 → vote=1
      bb:           { upper: 110, middle: 100, lower: 90, bandwidth: 0.2 },
      currentPrice: 91,  // BB 하단 → vote=1
    });
    assert.ok(Array.isArray(votes), '배열 반환');
    assert.ok(votes.length > 0, '투표 존재');
    const rsiVote = votes.find(v => v.name === 'rsi');
    assert.ok(rsiVote, 'rsi 투표 존재');
    assert.equal(rsiVote.vote, 1, 'RSI < 30 → vote=1');
  }

  // ─── 6. REGIME_WEIGHTS — 가중치 합 검증
  {
    for (const [regime, weights] of Object.entries(REGIME_WEIGHTS)) {
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1.0) < 0.001, `${regime} 가중치 합 ≈ 1.0: ${total}`);
    }
  }

  console.log('ta-weighted-voting-smoke ok (6/6)');
  return { ok: true, passed: 6, total: 6 };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: '❌ ta-weighted-voting-smoke 실패:',
  });
}

export default { runSmoke };
