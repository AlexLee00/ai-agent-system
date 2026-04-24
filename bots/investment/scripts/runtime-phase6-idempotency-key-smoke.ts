#!/usr/bin/env node
// @ts-nocheck

import { buildPartialAdjustIdempotencyKey } from './partial-adjust-runner.ts';
import { buildStrategyExitIdempotencyKey } from './strategy-exit-runner.ts';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed += 1;
    return;
  }
  console.error(`  ❌ ${label}`);
  failed += 1;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function main() {
  console.log('🧪 runtime-phase6-idempotency-key smoke test');
  const baseRuntimeState = {
    version: 7,
    updatedAt: '2026-04-24T10:15:00.000Z',
  };
  const baseCandidate = {
    symbol: 'PHA/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    reasonCode: 'profit_lock_candidate',
    partialExitRatio: 0.5,
    positionAmount: 123.45,
    estimatedNotional: 321.09,
    positionValue: 321.09,
    strategyProfile: {
      id: 'profile-pha-v1',
      strategyName: 'trend_following',
      setupType: 'momentum_rotation',
      positionRuntimeState: baseRuntimeState,
    },
  };

  const p1 = buildPartialAdjustIdempotencyKey(baseCandidate);
  const p2 = buildPartialAdjustIdempotencyKey(clone(baseCandidate));
  assert('partial-adjust: 같은 snapshot key 동일', p1 === p2);

  const pVersionChanged = buildPartialAdjustIdempotencyKey({
    ...clone(baseCandidate),
    strategyProfile: {
      ...clone(baseCandidate.strategyProfile),
      positionRuntimeState: { ...baseRuntimeState, version: 8 },
    },
  });
  assert('partial-adjust: runtime version 변경 시 key 변경', pVersionChanged !== p1);

  const pUpdatedChanged = buildPartialAdjustIdempotencyKey({
    ...clone(baseCandidate),
    strategyProfile: {
      ...clone(baseCandidate.strategyProfile),
      positionRuntimeState: { ...baseRuntimeState, updatedAt: '2026-04-24T10:16:00.000Z' },
    },
  });
  assert('partial-adjust: runtime updatedAt 변경 시 key 변경', pUpdatedChanged !== p1);

  const s1 = buildStrategyExitIdempotencyKey(baseCandidate);
  const s2 = buildStrategyExitIdempotencyKey(clone(baseCandidate));
  assert('strategy-exit: 같은 snapshot key 동일', s1 === s2);

  const sVersionChanged = buildStrategyExitIdempotencyKey({
    ...clone(baseCandidate),
    strategyProfile: {
      ...clone(baseCandidate.strategyProfile),
      positionRuntimeState: { ...baseRuntimeState, version: 9 },
    },
  });
  assert('strategy-exit: runtime version 변경 시 key 변경', sVersionChanged !== s1);

  const sUpdatedChanged = buildStrategyExitIdempotencyKey({
    ...clone(baseCandidate),
    strategyProfile: {
      ...clone(baseCandidate.strategyProfile),
      positionRuntimeState: { ...baseRuntimeState, updatedAt: '2026-04-24T10:17:00.000Z' },
    },
  });
  assert('strategy-exit: runtime updatedAt 변경 시 key 변경', sUpdatedChanged !== s1);

  const delayed = buildPartialAdjustIdempotencyKey(clone(baseCandidate));
  assert('Date.now/random 비의존(호출 시점 달라도 동일)', delayed === p1);

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
