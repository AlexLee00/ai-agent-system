#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  buildPositionScopeKey,
  recordLifecycleEvent,
  recordPhase6Start,
  recordPhase6Result,
  recordPhase6ReviewCreated,
  LIFECYCLE_PHASES,
  LIFECYCLE_EVENT_TYPES,
} from '../shared/lifecycle-contract.ts';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log('🧪 lifecycle-contract smoke test');
  await db.initSchema();

  // 1. buildPositionScopeKey
  const key = buildPositionScopeKey('BTC/USDT', 'binance', 'normal');
  assert('buildPositionScopeKey 형식 확인', key === 'binance:BTC/USDT:normal');

  // 2. LIFECYCLE_PHASES 6개 확인
  assert('LIFECYCLE_PHASES 6개', LIFECYCLE_PHASES.length === 6);
  assert('phase6_closeout 포함', LIFECYCLE_PHASES.includes('phase6_closeout'));

  // 3. recordLifecycleEvent — 실제 INSERT (smoke용 symbol)
  const eventId = await recordLifecycleEvent({
    positionScopeKey: 'binance:SMOKE_TEST/USDT:normal',
    exchange: 'binance',
    symbol: 'SMOKE_TEST/USDT',
    tradeMode: 'normal',
    phase: 'phase5_monitor',
    ownerAgent: 'smoke',
    eventType: LIFECYCLE_EVENT_TYPES.started,
    inputSnapshot: { test: true },
  });
  assert('recordLifecycleEvent 반환값 존재', typeof eventId === 'string' && eventId.length > 0);

  // 4. idempotency — 같은 key로 두 번 호출하면 같은 id 반환
  const ikey = `smoke:idem:${Date.now()}`;
  const id1 = await recordLifecycleEvent({
    positionScopeKey: 'binance:IDEM_TEST/USDT:normal',
    exchange: 'binance', symbol: 'IDEM_TEST/USDT', tradeMode: 'normal',
    phase: 'phase6_closeout', eventType: 'partial_adjust', idempotencyKey: ikey,
  });
  const id2 = await recordLifecycleEvent({
    positionScopeKey: 'binance:IDEM_TEST/USDT:normal',
    exchange: 'binance', symbol: 'IDEM_TEST/USDT', tradeMode: 'normal',
    phase: 'phase6_closeout', eventType: 'partial_adjust', idempotencyKey: ikey,
  });
  assert('idempotency: 같은 key로 두 번 호출 시 동일 id', id1 === id2);

  // 5. recordPhase6Start
  const p6Id = await recordPhase6Start({
    symbol: 'ETH/USDT', exchange: 'binance', tradeMode: 'normal',
    closeoutType: 'partial_adjust', signalId: 'smoke-sig-001',
    inputSnapshot: { reasonCode: 'profit_lock_candidate' },
  });
  assert('recordPhase6Start 반환값 존재', typeof p6Id === 'string');

  // 6. recordPhase6Result
  const p6rId = await recordPhase6Result({
    symbol: 'ETH/USDT', exchange: 'binance', tradeMode: 'normal',
    closeoutType: 'partial_adjust', signalId: 'smoke-sig-001',
    outputSnapshot: { executedRatio: 0.5, pnlRealized: 12.5 }, success: true,
  });
  assert('recordPhase6Result 반환값 존재', typeof p6rId === 'string');

  // 7. getLifecycleEventsForScope
  const events = await db.getLifecycleEventsForScope('binance:SMOKE_TEST/USDT:normal');
  assert('getLifecycleEventsForScope 결과 배열', Array.isArray(events));

  // 8. insertCloseoutReview
  const reviewId = await db.insertCloseoutReview({
    exchange: 'binance', symbol: 'SMOKE_TEST/USDT', tradeMode: 'normal',
    closeoutType: 'partial_adjust', closeoutReason: 'profit_lock_candidate',
    plannedRatio: 0.5, plannedNotional: 100,
    regime: 'volatile', setupType: 'mean_reversion',
    strategyFamily: 'mean_reversion', familyBias: 'downweight_by_pnl',
    idempotencyKey: `smoke:review:${Date.now()}`,
  });
  assert('insertCloseoutReview 반환값 존재', typeof reviewId === 'string');

  // 9. recordPhase6ReviewCreated
  const rvEventId = await recordPhase6ReviewCreated({
    symbol: 'SMOKE_TEST/USDT', exchange: 'binance', tradeMode: 'normal',
    reviewId, closeoutType: 'partial_adjust',
  });
  assert('recordPhase6ReviewCreated 반환값 존재', typeof rvEventId === 'string');

  // 10. getRecentCloseoutReviews
  const reviews = await db.getRecentCloseoutReviews({ days: 1, symbol: 'SMOKE_TEST/USDT' });
  assert('getRecentCloseoutReviews 결과 배열', Array.isArray(reviews));

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
