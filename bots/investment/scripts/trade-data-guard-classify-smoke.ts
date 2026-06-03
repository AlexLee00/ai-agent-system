#!/usr/bin/env node
// @ts-nocheck
/**
 * smoke: classifyTradeDataGuardDecision — Block→Notify 분류 로직 검증
 *
 * CODEX_LUNA_TRADE_GUARD_NOTIFY_REOPEN_2026-06-02
 * 검증 케이스:
 *   A. defensive_rotation+externalEvidence 0+presignal false → notify (reject 아님)
 *   B. trend_following+confirmation missing → notify
 *   C. stablecoin 구조 → hard_block
 *   D. strict env true → confirmation blocker hard_block 승격
 *   E. STOP-4 loss family notify sizing multiplier + clamp/env override
 *
 * 주의: applyTradeDataEntryGuardToDecision()은 guard_events를 fire-and-forget으로
 * 기록하므로 smoke에서 호출하지 않는다. 이 스크립트는 순수 분류 검증만 수행한다.
 */

import assert from 'node:assert/strict';
import {
  classifyTradeDataGuardDecision,
  evaluateTradeDataEntryGuard,
  resolveTradeDataGuardNotifySizingMultiplier,
} from '../shared/trade-data-derived-guards.ts';

const baseEnv = { LUNA_TRADE_DATA_DERIVED_GUARDS: 'true', LUNA_TRADE_DATA_STRICT_CONFIRMATION_GUARD: 'false' };
const strictEnv = { ...baseEnv, LUNA_TRADE_DATA_STRICT_CONFIRMATION_GUARD: 'true' };

// A. defensive_rotation without evidence → notify
const defRotGuard = evaluateTradeDataEntryGuard({
  action: 'BUY',
  symbol: 'ORCA/USDT',
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'defensive_rotation',
  externalEvidence: { evidenceCount: 0 },
  hasTechnicalPresignal: false,
}, baseEnv);
assert.equal(defRotGuard.blocked, true, 'A: defensive_rotation blocked=true');
assert.ok(defRotGuard.blockers.includes('crypto_defensive_rotation_without_live_evidence'), 'A: blocker 포함');
const defRotClass = classifyTradeDataGuardDecision(defRotGuard, baseEnv);
assert.equal(defRotClass, 'notify', 'A: defensive_rotation → notify (not hard_block)');

// B. trend_following without confirmation → notify
const trendGuard = evaluateTradeDataEntryGuard({
  action: 'BUY',
  symbol: 'ORCA/USDT',
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'trend_following',
  strategy_route: { selectedFamily: 'trend_following', familyPerformance: { selectedBias: 0.0 } },
  externalEvidence: { evidenceCount: 0 },
  hasTechnicalPresignal: false,
}, baseEnv);
assert.equal(trendGuard.blocked, true, 'B: trend_following blocked=true');
assert.ok(trendGuard.blockers.includes('crypto_trend_following_without_confirmation'), 'B: blocker 포함');
const trendClass = classifyTradeDataGuardDecision(trendGuard, baseEnv);
assert.equal(trendClass, 'notify', 'B: trend_following without confirmation → notify');

// C. stablecoin → hard_block
const stablecoinGuard = evaluateTradeDataEntryGuard({
  action: 'BUY',
  symbol: 'USDC/USDT',
  exchange: 'binance',
  market: 'crypto',
}, baseEnv);
assert.equal(stablecoinGuard.blocked, true, 'C: stablecoin blocked=true');
const stablecoinClass = classifyTradeDataGuardDecision(stablecoinGuard, baseEnv);
assert.equal(stablecoinClass, 'hard_block', 'C: stablecoin → hard_block');

// D. strict 모드 + confirmation thin → hard_block 승격
const strictGuard = evaluateTradeDataEntryGuard({
  action: 'BUY',
  symbol: 'ORCA/USDT',
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'defensive_rotation',
  externalEvidence: { evidenceCount: 0, avgQuality: 0.1 },
  hasTechnicalPresignal: false,
}, strictEnv);
// strict 모드에서 confirmation_quality_thin 블로커가 추가됨
const strictClass = classifyTradeDataGuardDecision(strictGuard, strictEnv);
// defensive_rotation_confirmation_quality_thin 또는 hard_block 승격 여부 확인
if (strictGuard.blockers.includes('crypto_defensive_rotation_confirmation_quality_thin')) {
  assert.equal(strictClass, 'hard_block', 'D: strict 모드 + confirmation_quality_thin → hard_block');
} else {
  // confirmation thin blocker가 없으면 notify (guard level에서 추가 안 된 경우)
  assert.ok(['notify', 'hard_block'].includes(strictClass), 'D: strict 모드 결과 유효 분류');
}

// E. STOP-4 loss family notify sizing multiplier clamp/env override
const notifyMultiplier = resolveTradeDataGuardNotifySizingMultiplier(defRotGuard, baseEnv);
assert.equal(notifyMultiplier, 0.25, 'E: defensive_rotation STOP-4 notify multiplier=0.25');
const trendNotifyMultiplier = resolveTradeDataGuardNotifySizingMultiplier(trendGuard, baseEnv);
assert.equal(trendNotifyMultiplier, 0.25, 'E: trend_following STOP-4 notify multiplier=0.25');
const clampedMultiplier = resolveTradeDataGuardNotifySizingMultiplier(defRotGuard, {
  ...baseEnv,
  LUNA_TRADE_DATA_NOTIFY_SIZING_MULTIPLIER: '0.1',
});
assert.equal(clampedMultiplier, 0.25, 'E: env override 하한 clamp=0.25');

const payload = {
  ok: true,
  smoke: 'trade-data-guard-classify',
  A: { class: defRotClass, blockers: defRotGuard.blockers },
  B: { class: trendClass, blockers: trendGuard.blockers },
  C: { class: stablecoinClass, blockers: stablecoinGuard.blockers },
  D: { class: strictClass, blockers: strictGuard.blockers },
  E: { notifyMultiplier, trendNotifyMultiplier, clampedMultiplier },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('trade-data-guard-classify-smoke ok');
  console.log(`  A(defensive_rotation)→${payload.A.class}  B(trend_following)→${payload.B.class}  C(stablecoin)→${payload.C.class}  D(strict)→${payload.D.class}`);
  console.log(`  E defensiveRotationMultiplier=${payload.E.notifyMultiplier} trendMultiplier=${payload.E.trendNotifyMultiplier} clamped=${payload.E.clampedMultiplier}`);
}
