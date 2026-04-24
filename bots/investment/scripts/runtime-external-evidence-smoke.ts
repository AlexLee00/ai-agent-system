#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  recordEvidence, recordBacktestEvidence, recordScoutEvidence,
  buildEvidenceSummaryForAgent, computeSourceQuality, computeFreshnessScore,
} from '../shared/external-evidence-ledger.ts';
import {
  readExternalEvidenceGapTaskQueue,
  updateExternalEvidenceGapTaskQueue,
} from '../shared/evidence-gap-task-queue.ts';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

async function main() {
  console.log('🧪 runtime-external-evidence smoke test');
  await db.initSchema();

  // 1. computeSourceQuality — cap 적용
  assert('community quality cap 0.6', computeSourceQuality('community', 0.9) <= 0.60);
  assert('backtest quality cap 0.9', computeSourceQuality('backtest', 1.0) <= 0.90);
  assert('research quality cap 0.85', computeSourceQuality('research', 1.0) <= 0.85);

  // 2. computeFreshnessScore
  assert('freshness ageHours=0 → 1.0', computeFreshnessScore(0) === 1.0);
  assert('freshness ageHours=72 → decay < 0.5', computeFreshnessScore(72) < 0.5);
  assert('freshness ageHours=168 → >= 0.05', computeFreshnessScore(168) >= 0.05);

  // 3. recordEvidence
  const id1 = await recordEvidence({
    sourceType: 'community',
    sourceName: 'reddit_smoke',
    symbol: 'BTC/USDT',
    market: 'crypto',
    strategyFamily: 'breakout',
    signalDirection: 'bullish',
    score: 0.6,
    sourceQuality: 0.55,
    freshnessScore: 0.9,
    evidenceSummary: 'smoke test community evidence',
  });
  assert('recordEvidence 반환값 존재', typeof id1 === 'string');

  // 4. recordBacktestEvidence
  const id2 = await recordBacktestEvidence({
    symbol: 'ETH/USDT',
    market: 'crypto',
    strategyFamily: 'mean_reversion',
    sharpe: 1.5,
    winRate: 0.62,
    totalTrades: 45,
    backwindowDays: 30,
    isOutOfSample: true,
  });
  assert('recordBacktestEvidence (out-of-sample) 반환값 존재', typeof id2 === 'string');

  // 5. recordScoutEvidence
  const id3 = await recordScoutEvidence({
    symbol: 'SOL/USDT',
    market: 'crypto',
    strategyFamily: 'momentum_rotation',
    signalDirection: 'bullish',
    score: 0.72,
    summary: 'scout smoke evidence',
  });
  assert('recordScoutEvidence 반환값 존재', typeof id3 === 'string');

  // 6. buildEvidenceSummaryForAgent — 존재하는 심볼
  const summary = await buildEvidenceSummaryForAgent({ symbol: 'BTC/USDT', days: 1 });
  assert('buildEvidenceSummaryForAgent evidenceCount >= 0', summary.evidenceCount >= 0);
  assert('buildEvidenceSummaryForAgent signals 구조', typeof summary.signals?.bullish === 'number');
  assert('topEvidences 배열', Array.isArray(summary.topEvidences));

  // 7. buildEvidenceSummaryForAgent — 데이터 없는 심볼
  const emptySummary = await buildEvidenceSummaryForAgent({ symbol: 'NOSYMBOL/USDT', days: 1 });
  assert('evidenceCount=0 심볼 → warning 존재', emptySummary.warning != null);

  // 8. getRecentExternalEvidence
  const rows = await db.getRecentExternalEvidence({ days: 1, symbol: 'ETH/USDT' });
  assert('getRecentExternalEvidence 배열', Array.isArray(rows));

  // 9. external evidence gap task queue
  const queueFile = `/tmp/investment-evidence-gap-queue-smoke-${Date.now()}.json`;
  const gap1 = updateExternalEvidenceGapTaskQueue({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    evidenceCount: 0,
    threshold: 2,
    cooldownMinutes: 1,
    file: queueFile,
  });
  const gap2 = updateExternalEvidenceGapTaskQueue({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    evidenceCount: 0,
    threshold: 2,
    cooldownMinutes: 1,
    file: queueFile,
  });
  const queueAfterGap = readExternalEvidenceGapTaskQueue(queueFile);
  assert('evidence gap 2회 누적 시 task queue 생성', gap2.queuedNow === true);
  assert('queue에 queued task 존재', Number(queueAfterGap.summary?.queued || 0) >= 1);

  const recovered = updateExternalEvidenceGapTaskQueue({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    evidenceCount: 3,
    threshold: 2,
    cooldownMinutes: 1,
    file: queueFile,
  });
  assert('evidence 복구 시 상태 recovered', recovered.status === 'evidence_recovered');
  const queueAfterRecover = readExternalEvidenceGapTaskQueue(queueFile);
  assert(
    '복구 시 queued/retrying task 해소',
    Number(queueAfterRecover.summary?.queued || 0) === 0 && Number(queueAfterRecover.summary?.retrying || 0) === 0,
  );

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
