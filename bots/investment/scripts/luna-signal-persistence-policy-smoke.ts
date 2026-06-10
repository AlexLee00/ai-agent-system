#!/usr/bin/env node
// @ts-nocheck

import {
  applyExistingPositionStrategyBias,
  buildLunaRiskEvaluationSignal,
  buildLunaSignalPersistencePlan,
  evaluateLunaSignalCapitalPersistencePreflight,
  evaluateLunaSignalPersistencePreFilter,
} from '../shared/luna-signal-persistence-policy.ts';

const baseSignal = {
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amountUsdt: 100,
  confidence: 0.8,
  reasoning: 'smoke',
  tradeMode: 'normal',
};

const biased = applyExistingPositionStrategyBias(baseSignal, {
  id: 7,
  setup_type: 'breakout',
  strategy_state: { lifecycleStatus: 'holding' },
  responsibilityPlan: { ownerMode: 'capital_preservation' },
  executionPlan: { entrySizingMultiplier: 0.8 },
});

const riskSignal = buildLunaRiskEvaluationSignal(baseSignal);
const approved = buildLunaSignalPersistencePlan(baseSignal, {
  approved: true,
  adjustedAmount: 72,
  nemesis_verdict: 'approved',
}, null, {
  exchange: 'binance',
  decision: { amount_usdt: 100, confidence: 0.8 },
});
const rejected = buildLunaSignalPersistencePlan(baseSignal, {
  approved: false,
  reason: 'risk_too_high',
  adjustedAmount: 0,
}, null, {
  exchange: 'binance',
  decision: { amount_usdt: 100 },
});
const failed = buildLunaSignalPersistencePlan(baseSignal, null, new Error('nemesis down'), {
  exchange: 'binance',
  decision: { amount_usdt: 100 },
});
const prefilterDefaultOff = evaluateLunaSignalPersistencePreFilter({
  ...baseSignal,
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'defensive_rotation',
  externalEvidence: { evidenceCount: 0 },
  hasTechnicalPresignal: false,
}, {
  env: {},
  exchange: 'binance',
  market: 'crypto',
});
const prefilterOptIn = evaluateLunaSignalPersistencePreFilter({
  ...baseSignal,
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'defensive_rotation',
  externalEvidence: { evidenceCount: 0 },
  hasTechnicalPresignal: false,
}, {
  env: {
    LUNA_SIGNAL_PREFILTER_PERSISTENCE_BLOCK_ENABLED: 'true',
    LUNA_TRADE_DATA_DERIVED_GUARDS: 'true',
  },
  exchange: 'binance',
  market: 'crypto',
});
const approvedPrefilterBlocked = buildLunaSignalPersistencePlan({
  ...baseSignal,
  exchange: 'binance',
  market: 'crypto',
  strategy_family: 'defensive_rotation',
  externalEvidence: { evidenceCount: 0 },
  hasTechnicalPresignal: false,
}, {
  approved: true,
  adjustedAmount: 72,
  nemesis_verdict: 'approved',
}, null, {
  exchange: 'binance',
  market: 'crypto',
  decision: { amount_usdt: 100, confidence: 0.8 },
  env: {
    LUNA_SIGNAL_PREFILTER_PERSISTENCE_BLOCK_ENABLED: 'true',
    LUNA_TRADE_DATA_DERIVED_GUARDS: 'true',
  },
});

async function runCapitalPreflightCases() {
  const riskApproved = { approved: true, adjustedAmount: 40 };
  const off = await evaluateLunaSignalCapitalPersistencePreflight(baseSignal, riskApproved, {
    env: {},
    exchange: 'binance',
    tradeMode: 'validation',
    deps: {
      preTradeCheck: async () => {
        throw new Error('should not run when disabled');
      },
    },
  });
  if (off.enabled !== false || off.blocked !== false) {
    throw new Error(`capital preflight default-off mismatch: ${JSON.stringify(off)}`);
  }

  const normalSkipped = await evaluateLunaSignalCapitalPersistencePreflight(baseSignal, riskApproved, {
    env: { LUNA_SIGNAL_CAPITAL_PREFLIGHT_PERSISTENCE_BLOCK_ENABLED: 'true' },
    exchange: 'binance',
    tradeMode: 'normal',
    deps: {
      preTradeCheck: async () => {
        throw new Error('normal mode should be out of default scope');
      },
    },
  });
  if (normalSkipped.blocked !== false || normalSkipped.reason !== 'trade_mode_not_in_scope:normal') {
    throw new Error(`capital preflight normal scope mismatch: ${JSON.stringify(normalSkipped)}`);
  }

  const blocked = await evaluateLunaSignalCapitalPersistencePreflight(baseSignal, riskApproved, {
    env: { LUNA_SIGNAL_CAPITAL_PREFLIGHT_PERSISTENCE_BLOCK_ENABLED: 'true' },
    exchange: 'binance',
    tradeMode: 'validation',
    deps: {
      preTradeCheck: async (_symbol, _action, amount, exchange, tradeMode) => ({
        allowed: false,
        reason: 'live_fire_daily_notional_limit: 240.00 > 200',
        dailyNotional: 200,
        maxDailyNotional: 200,
        amount,
        exchange,
        tradeMode,
      }),
    },
  });
  if (
    blocked.blocked !== true
    || blocked.blockUpdate?.code !== 'capital_guard_rejected'
    || blocked.blockUpdate?.meta?.execution_blocked_by !== 'signal_persistence_capital_preflight'
    || blocked.blockUpdate?.meta?.tradeMode !== 'validation'
  ) {
    throw new Error(`capital preflight block mismatch: ${JSON.stringify(blocked)}`);
  }

  const failOpen = await evaluateLunaSignalCapitalPersistencePreflight(baseSignal, riskApproved, {
    env: { LUNA_SIGNAL_CAPITAL_PREFLIGHT_PERSISTENCE_BLOCK_ENABLED: 'true' },
    exchange: 'binance',
    tradeMode: 'validation',
    deps: {
      preTradeCheck: async () => {
        throw new Error('capital backend unavailable');
      },
    },
  });
  if (failOpen.blocked !== false || failOpen.check?.error !== 'capital backend unavailable') {
    throw new Error(`capital preflight fail-open mismatch: ${JSON.stringify(failOpen)}`);
  }

  return {
    off: off.reason,
    normalSkipped: normalSkipped.reason,
    blockedCode: blocked.blockUpdate.code,
    failOpenError: failOpen.check.error,
  };
}

const capitalPreflight = await runCapitalPreflightCases();

if (!biased.applied || biased.signalData.amountUsdt !== 88 || !biased.signalData.existingExecutionPlan) {
  throw new Error(`existing position bias mismatch: ${JSON.stringify(biased)}`);
}
if (riskSignal.amount_usdt !== 100 || riskSignal.trade_mode !== 'normal') {
  throw new Error(`risk signal mismatch: ${JSON.stringify(riskSignal)}`);
}
if (approved.outcome !== 'approved' || approved.signalData.amountUsdt !== 72 || !approved.approvalUpdate) {
  throw new Error(`approved persistence mismatch: ${JSON.stringify(approved)}`);
}
if (rejected.outcome !== 'rejected' || rejected.blockUpdate?.code !== 'risk_rejected') {
  throw new Error(`rejected persistence mismatch: ${JSON.stringify(rejected)}`);
}
if (failed.outcome !== 'failed' || failed.blockUpdate?.code !== 'nemesis_error') {
  throw new Error(`failed persistence mismatch: ${JSON.stringify(failed)}`);
}
if (prefilterDefaultOff.enabled !== false || prefilterDefaultOff.blocked !== false) {
  throw new Error(`prefilter default-off mismatch: ${JSON.stringify(prefilterDefaultOff)}`);
}
if (
  prefilterOptIn.enabled !== true
  || prefilterOptIn.blocked !== true
  || !prefilterOptIn.blockers.includes('crypto_defensive_rotation_without_live_evidence')
) {
  throw new Error(`prefilter opt-in mismatch: ${JSON.stringify(prefilterOptIn)}`);
}
if (
  approvedPrefilterBlocked.outcome !== 'blocked_by_prefilter'
  || approvedPrefilterBlocked.status !== 'blocked'
  || approvedPrefilterBlocked.blockUpdate?.code !== 'trade_data_entry_guard_rejected'
  || approvedPrefilterBlocked.blockUpdate?.meta?.execution_blocked_by !== 'signal_persistence_prefilter'
) {
  throw new Error(`approved prefilter block mismatch: ${JSON.stringify(approvedPrefilterBlocked)}`);
}

const payload = {
  ok: true,
  smoke: 'luna-signal-persistence-policy',
  biasedAmount: biased.signalData.amountUsdt,
  approvedStatus: approved.status,
  rejectedStatus: rejected.status,
  failedStatus: failed.status,
  prefilterBlockers: prefilterOptIn.blockers,
  prefilterBlockedStatus: approvedPrefilterBlocked.status,
  capitalPreflight,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ luna signal persistence policy smoke passed');
}
