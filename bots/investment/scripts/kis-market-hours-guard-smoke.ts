#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  evaluateKisMarketHours,
  getNextOpenTime,
  deferSignal,
  flushDeferredSignals,
} from '../shared/kis-market-hours-guard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  // 한국장 개장: UTC 01:00 = KST 10:00 목요일
  const domesticOpen = evaluateKisMarketHours({
    market: 'domestic',
    now: new Date('2026-04-30T01:00:00Z'),
  });
  assert.equal(domesticOpen.state, 'open');
  assert.equal(domesticOpen.nextAction, 'allow');

  // 한국장 폐장: UTC 08:00 = KST 17:00
  const domesticClosed = evaluateKisMarketHours({
    market: 'domestic',
    now: new Date('2026-04-30T08:00:00Z'),
  });
  assert.equal(domesticClosed.state, 'closed');
  assert.equal(domesticClosed.nextAction, 'defer_until_open');

  // 미국장 overseas 체크: KST 토요일 새벽이어도 ET 금요일 장중이면 open이어야 한다.
  const overseas = evaluateKisMarketHours({
    market: 'overseas',
    now: new Date('2026-05-08T15:34:00Z'),
  });
  assert.equal(overseas.state, 'open');
  assert.equal(overseas.nextAction, 'allow');
  assert.equal(overseas.marketDateStr, '2026-05-08');

  const overseasClosed = evaluateKisMarketHours({
    market: 'overseas',
    now: new Date('2026-05-09T03:00:00Z'),
  });
  assert.equal(overseasClosed.state, 'closed');

  // getNextOpenTime — 폐장 중이면 nextOpen이 null이 아님
  const next = getNextOpenTime({ market: 'domestic', now: new Date('2026-04-30T08:00:00Z') });
  assert.ok(next.nextOpen !== null, 'nextOpen should not be null when closed');
  assert.ok(next.minutesUntilOpen > 0, 'minutesUntilOpen > 0');

  const overseasNext = getNextOpenTime({ market: 'overseas', now: new Date('2026-05-09T03:00:00Z') });
  assert.ok(overseasNext.nextOpen !== null, 'overseas nextOpen should not be null when closed');
  assert.ok(overseasNext.minutesUntilOpen > 0, 'overseas minutesUntilOpen > 0');

  // getNextOpenTime — 개장 중이면 alreadyOpen=true
  const nextOpen = getNextOpenTime({ market: 'domestic', now: new Date('2026-04-30T01:00:00Z') });
  assert.equal(nextOpen.alreadyOpen, true);

  // deferSignal + flushDeferredSignals
  const sig = { id: 'sig-test-1', symbol: 'SAMSUNG', action: 'BUY' };
  const deferred = deferSignal(sig, 'domestic', new Date('2026-04-30T08:00:00Z'));
  assert.ok(deferred.ok, 'deferSignal ok');

  // 폐장 시간 → flush 결과: still
  const flush1 = flushDeferredSignals('domestic', new Date('2026-04-30T08:00:00Z'));
  assert.equal(flush1.readyCount, 0);
  assert.equal(flush1.stillCount, 1);

  // 개장 시간 → flush 결과: ready
  const deferSignal2 = deferSignal({ id: 'sig-test-2', symbol: 'KAKAO', action: 'BUY' }, 'domestic', new Date('2026-04-30T08:00:00Z'));
  const flush2 = flushDeferredSignals('domestic', new Date('2026-04-30T01:00:00Z'));
  assert.ok(flush2.readyCount >= 1, `readyCount=${flush2.readyCount}`);

  return { ok: true, domesticOpen, domesticClosed, overseas, overseasClosed, next, overseasNext, nextOpen };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ kis-market-hours-guard-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ kis-market-hours-guard-smoke 실패:' });
}
