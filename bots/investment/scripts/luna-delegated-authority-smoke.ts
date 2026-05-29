#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_DELEGATED_AUTHORITY_TOKEN,
  buildLunaDelegatedAuthorityDecision,
  getLunaDelegatedAuthorityPolicy,
} from '../shared/luna-delegated-authority.ts';

function delegatedEnv(extra = {}) {
  return {
    LUNA_DELEGATED_AUTHORITY_ENABLED: 'true',
    LUNA_MASTER_REPORT_ONLY: 'true',
    LUNA_LIVE_FIRE_MAX_DAILY: '200',
    LUNA_LIVE_FIRE_MAX_OPEN: '5',
    ...extra,
  };
}

function ratioDelegatedEnv(extra = {}) {
  return delegatedEnv({
    LUNA_DELEGATED_TRADE_RATIO: '0.05',
    LUNA_DELEGATED_DAILY_RATIO: '0.20',
    LUNA_DELEGATED_TRADE_RATIO_HARD_CAP: '0.10',
    LUNA_DELEGATED_DAILY_RATIO_HARD_CAP: '0.40',
    LUNA_DELEGATED_MAX_OPEN_POSITIONS: '5',
    ...extra,
  });
}

export function runLunaDelegatedAuthoritySmoke() {
  const disabled = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: {},
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 0, maxDailyUsdt: 200, maxOpen: 5 },
  });
  assert.equal(disabled.canSelfApprove, false);
  assert.ok(disabled.blockers.includes('delegated_authority_disabled'));

  const approved = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 0, maxDailyUsdt: 160, maxOpen: 5 },
  });
  assert.equal(approved.canSelfApprove, true);
  assert.equal(approved.approvalToken, LUNA_DELEGATED_AUTHORITY_TOKEN);
  assert.equal(approved.masterRole, 'report_only');

  const runtimeConfigApproved = buildLunaDelegatedAuthorityDecision({
    action: 'runtime_config_apply',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
  });
  assert.equal(runtimeConfigApproved.canSelfApprove, true);

  const safeMaintenanceApproved = buildLunaDelegatedAuthorityDecision({
    action: 'safe_maintenance_apply',
    env: delegatedEnv(),
    finalGate: { ok: true, blockers: [] },
  });
  assert.equal(safeMaintenanceApproved.canSelfApprove, true);

  const unknownBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'unregistered_apply',
    env: delegatedEnv(),
  });
  assert.equal(unknownBlocked.canSelfApprove, false);
  assert.ok(unknownBlocked.blockers.includes('delegated_action_not_registered:unregistered_apply'));

  const capBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv({ LUNA_DELEGATED_MAX_TRADE_USDT: '50' }),
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 51, maxDailyUsdt: 200, maxOpen: 5 },
  });
  assert.equal(capBlocked.canSelfApprove, false);
  assert.ok(capBlocked.blockers.some((item) => item.startsWith('trade_cap_exceeded')));

  const gateBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: delegatedEnv(),
    finalGate: { ok: false, blockers: ['manual_reconcile_tasks:1'] },
    caps: { maxUsdt: 0, maxDailyUsdt: 200, maxOpen: 5 },
  });
  assert.equal(gateBlocked.canSelfApprove, false);
  assert.ok(gateBlocked.blockers.includes('manual_reconcile_tasks:1'));

  const ackBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'reconcile_ack',
    env: delegatedEnv(),
    reconcileEvidence: { evidenceHash: null, verifiedNotFound: false },
  });
  assert.equal(ackBlocked.canSelfApprove, false);
  assert.ok(ackBlocked.blockers.includes('delegated_reconcile_ack_disabled'));
  assert.ok(ackBlocked.blockers.includes('reconcile_evidence_hash_required'));

  const ackApproved = buildLunaDelegatedAuthorityDecision({
    action: 'reconcile_ack',
    env: delegatedEnv({ LUNA_DELEGATED_RECONCILE_ACK_ENABLED: 'true' }),
    reconcileEvidence: { evidenceHash: 'sha256:abc', verifiedNotFound: true },
  });
  assert.equal(ackApproved.canSelfApprove, true);

  const policy = getLunaDelegatedAuthorityPolicy(delegatedEnv());
  assert.equal(policy.delegated, true);
  assert.equal(policy.reportOnly, true);

  const lowBullPolicy = getLunaDelegatedAuthorityPolicy(ratioDelegatedEnv(), {
    availableBalance: 1000,
    regime: 'low_volatility_bull',
    exchange: 'binance',
  });
  assert.equal(lowBullPolicy.limitMode, 'ratio');
  assert.equal(lowBullPolicy.maxTradeUsdt, 65);
  assert.equal(lowBullPolicy.maxDailyUsdt, 260);
  assert.equal(lowBullPolicy.hardCaps.tradeUsdt, 100);
  assert.equal(lowBullPolicy.hardCaps.dailyUsdt, 400);

  const highBearPolicy = getLunaDelegatedAuthorityPolicy(ratioDelegatedEnv(), {
    availableBalance: 1000,
    regime: 'high_volatility_bear',
    exchange: 'binance',
  });
  assert.equal(highBearPolicy.maxTradeUsdt, 20);
  assert.equal(highBearPolicy.maxDailyUsdt, 80);

  const unknownPolicy = getLunaDelegatedAuthorityPolicy(ratioDelegatedEnv(), {
    availableBalance: 1000,
    regime: 'unknown_regime',
    exchange: 'binance',
  });
  assert.equal(unknownPolicy.regimeMultiplier, 0.8);
  assert.equal(unknownPolicy.maxTradeUsdt, 40);
  assert.equal(unknownPolicy.maxDailyUsdt, 160);

  const clampedPolicy = getLunaDelegatedAuthorityPolicy(ratioDelegatedEnv({
    LUNA_REGIME_LIMIT_MULT_LOW_VOLATILITY_BULL: '3',
  }), {
    availableBalance: 1000,
    regime: 'low_volatility_bull',
    exchange: 'binance',
  });
  assert.equal(clampedPolicy.maxTradeUsdt, 100);
  assert.equal(clampedPolicy.maxDailyUsdt, 400);

  const zeroFundsBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: ratioDelegatedEnv(),
    runtimeInputs: { availableBalance: 0, regime: 'high_volatility_bull', exchange: 'binance' },
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 1, maxDailyUsdt: 1, maxOpen: 1 },
  });
  assert.equal(zeroFundsBlocked.canSelfApprove, false);
  assert.ok(zeroFundsBlocked.blockers.includes('available_funds_unavailable'));

  const minOrderBlocked = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_cutover',
    env: ratioDelegatedEnv(),
    runtimeInputs: { availableBalance: 200, regime: 'high_volatility_bull', exchange: 'binance' },
    finalGate: { ok: true, blockers: [] },
    caps: { maxUsdt: 10, maxDailyUsdt: 10, maxOpen: 1 },
  });
  assert.equal(minOrderBlocked.canSelfApprove, false);
  assert.ok(minOrderBlocked.blockers.some((item) => item.startsWith('trade_cap_below_min_order')));

  const domesticPolicy = getLunaDelegatedAuthorityPolicy(ratioDelegatedEnv(), {
    availableBalance: 1_000_000,
    regime: 'high_volatility_bull',
    exchange: 'kis',
  });
  assert.equal(domesticPolicy.exchange, 'kis');
  assert.equal(domesticPolicy.maxTradeUsdt, 50_000);
  assert.equal(domesticPolicy.maxDailyUsdt, 200_000);

  return {
    ok: true,
    status: 'luna_delegated_authority_smoke_passed',
    approved: approved.approvalSource,
    ratioLimits: {
      lowVolBull: { trade: lowBullPolicy.maxTradeUsdt, daily: lowBullPolicy.maxDailyUsdt },
      highVolBear: { trade: highBearPolicy.maxTradeUsdt, daily: highBearPolicy.maxDailyUsdt },
      unknown: { trade: unknownPolicy.maxTradeUsdt, daily: unknownPolicy.maxDailyUsdt },
      clamped: { trade: clampedPolicy.maxTradeUsdt, daily: clampedPolicy.maxDailyUsdt },
      domestic: { trade: domesticPolicy.maxTradeUsdt, daily: domesticPolicy.maxDailyUsdt },
    },
    blockedExamples: {
      cap: capBlocked.blockers,
      gate: gateBlocked.blockers,
      ack: ackBlocked.blockers,
      zeroFunds: zeroFundsBlocked.blockers,
      minOrder: minOrderBlocked.blockers,
    },
  };
}

async function main() {
  const result = runLunaDelegatedAuthoritySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.status);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna delegated authority smoke 실패:',
  });
}
