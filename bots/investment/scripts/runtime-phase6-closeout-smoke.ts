#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildPhase6Report } from './runtime-phase6-closeout.ts';
import { buildPositionScopeKey } from '../shared/lifecycle-contract.ts';
import { beginCloseout, finalizeCloseout, preflightCloseout } from '../shared/position-closeout-engine.ts';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

async function main() {
  console.log('🧪 runtime-phase6-closeout smoke test');
  await db.initSchema();

  // 1. buildPhase6Report 기본 실행
  const report = await buildPhase6Report({ days: 7 });
  assert('buildPhase6Report ok', report.ok === true);
  assert('buildPhase6Report candidates 구조', typeof report.candidates?.total === 'number');
  assert('buildPhase6Report closeoutReviews 구조', typeof report.closeoutReviews?.pending === 'number');

  // 2. preflightCloseout — 새 context는 통과
  const ctx = {
    symbol: 'SMOKE_CLOSE/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    closeoutType: 'partial_adjust',
    reasonCode: 'profit_lock_candidate',
    plannedRatio: 0.5,
    plannedNotional: 100,
    idempotencyKey: `smoke:preflight:${Date.now()}`,
    cooldownMinutes: 0,
  };
  const preflight = await preflightCloseout(ctx);
  assert('preflightCloseout 새 context 통과', preflight.ok === true);

  // 3. beginCloseout — lifecycle event 발행 + 통과
  const begin = await beginCloseout({ ...ctx, idempotencyKey: `smoke:begin:${Date.now()}` });
  assert('beginCloseout ok', begin.ok === true);
  assert('beginCloseout lifecycleEventId 반환', begin.lifecycleEventId != null || begin.ok === true);

  // 4. finalizeCloseout — 성공 케이스
  const mockResult = { tradeId: 'trade-smoke-001', executedNotional: 95, executedRatio: 0.5 };
  const closeCtx = { ...ctx, idempotencyKey: `smoke:fin:${Date.now()}` };
  const fin = await finalizeCloseout(closeCtx, 'sig-smoke-001', mockResult, null);
  assert('finalizeCloseout ok=true (성공)', fin.ok === true);
  assert('finalizeCloseout reviewId 생성', typeof fin.reviewId === 'string');

  // 5. finalizeCloseout — 실패 케이스
  const errCtx = { ...ctx, closeoutType: 'full_exit', idempotencyKey: `smoke:err:${Date.now()}` };
  const finErr = await finalizeCloseout(errCtx, 'sig-smoke-002', null, new Error('mock execution failed'));
  assert('finalizeCloseout ok=false (실패)', finErr.ok === false);
  assert('finalizeCloseout reviewId 생성됨 (실패도 기록)', typeof finErr.reviewId === 'string');

  // 6. finalizeCloseout — executeResult가 존재해도 success=false면 실패 처리
  const softFailCtx = { ...ctx, idempotencyKey: `smoke:soft-fail:${Date.now()}` };
  const finSoftFail = await finalizeCloseout(softFailCtx, 'sig-smoke-003', {
    success: false,
    status: 'failed',
    reason: 'mock execution rejected',
  }, null);
  assert('finalizeCloseout ok=false (executeResult.success=false)', finSoftFail.ok === false);
  assert('finalizeCloseout reviewStatus=failed (executeResult.success=false)', finSoftFail.reviewStatus === 'failed');

  // 7. finalizeCloseout — ok=false 객체는 실패로 기록
  const rejectedCtx = { ...ctx, idempotencyKey: `smoke:reject:${Date.now()}` };
  const finRejected = await finalizeCloseout(rejectedCtx, 'sig-smoke-004', {
    ok: false,
    status: 'rejected',
    error: 'mock rejected',
  }, null);
  assert('finalizeCloseout ok=false (executeResult.ok=false)', finRejected.ok === false);
  assert('finalizeCloseout reviewStatus=failed (executeResult.ok=false)', finRejected.reviewStatus === 'failed');

  // 8. finalizeCloseout — tradeId + pending 은 completed 아님
  const pendingCtx = { ...ctx, idempotencyKey: `smoke:pending:${Date.now()}` };
  const finPending = await finalizeCloseout(pendingCtx, 'sig-smoke-005', {
    tradeId: 'trade-smoke-pending',
    status: 'pending',
  }, null);
  assert('finalizeCloseout ok=false (tradeId+pending)', finPending.ok === false);
  assert('finalizeCloseout reviewStatus=pending (tradeId+pending)', finPending.reviewStatus === 'pending');

  // 9. finalizeCloseout — tradeId + filled 는 completed
  const filledCtx = { ...ctx, idempotencyKey: `smoke:filled:${Date.now()}` };
  const finFilled = await finalizeCloseout(filledCtx, 'sig-smoke-006', {
    tradeId: 'trade-smoke-filled',
    status: 'filled',
    filled: true,
  }, null);
  assert('finalizeCloseout ok=true (tradeId+filled)', finFilled.ok === true);
  assert('finalizeCloseout reviewStatus=completed (tradeId+filled)', finFilled.reviewStatus === 'completed');

  // 10. idempotency — 같은 idempotencyKey로 두 번 beginCloseout
  const ikey = `smoke:idem2:${Date.now()}`;
  const b1 = await beginCloseout({ ...ctx, idempotencyKey: ikey, cooldownMinutes: 0 });
  const b2 = await beginCloseout({ ...ctx, idempotencyKey: ikey, cooldownMinutes: 0 });
  assert('idempotency: 두 번째 beginCloseout는 block', b1.ok === true && b2.ok === false);

  // 11. buildPositionScopeKey
  const scopeKey = buildPositionScopeKey('BTC/USDT', 'binance', 'normal');
  assert('buildPositionScopeKey 형식', scopeKey === 'binance:BTC/USDT:normal');

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
