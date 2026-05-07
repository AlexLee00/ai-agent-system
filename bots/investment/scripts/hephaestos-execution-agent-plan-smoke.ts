#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildHephaestosExecutionAgentPlan } from '../team/hephaestos/execution-agent-plan.ts';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';
import { createBuyReentryGuardPolicy } from '../team/hephaestos/buy-reentry-guards.ts';

function buildRiskPolicy({ firstCheck, validationCheck = { allowed: true } } = {}) {
  return createRiskAndCapitalGatePolicy({
    getInvestmentExecutionRuntimeConfig: () => ({
      cryptoGuardSoftening: {
        byExchange: {
          binance: {
            tradeModes: {
              normal: {
                validationFallback: {
                  enabled: true,
                  allowedGuardKinds: ['max_positions'],
                  reductionMultiplier: 0.5,
                },
              },
              validation: {
                livePositionReentry: {
                  enabled: true,
                  reductionMultiplier: 0.4,
                },
              },
            },
          },
        },
      },
    }),
    preTradeCheck: async (_symbol, _side, _amount, _exchange, mode) => (mode === 'validation' ? validationCheck : firstCheck),
    db: { updateSignalBlock: async () => {} },
    notifyTradeSkip: async () => {},
    getOpenPositions: async () => [{ symbol: 'OLD/USDT' }],
    findAnyLivePosition: async () => null,
    fetchTicker: async () => 10,
    calculatePositionSize: async () => ({ skip: false, size: 50, capitalPct: 5, riskPercent: 1 }),
    getDynamicMinOrderAmount: async () => 10,
    getInvestmentTradeMode: () => 'normal',
  });
}

function buildReentryPolicy({ livePosition = { symbol: 'APE/USDT', paper: false } } = {}) {
  return createBuyReentryGuardPolicy({
    db: {
      getLivePosition: async () => livePosition,
      getPaperPosition: async () => null,
      getSameDayTrade: async () => null,
    },
    findAnyLivePosition: async () => null,
    isSameDaySymbolReentryBlockEnabled: () => false,
    getValidationLiveReentrySofteningPolicy: () => ({ enabled: true, reductionMultiplier: 0.4 }),
    rejectExecution: async ({ reason, code }) => ({ success: false, reason, code }),
    buildGuardTelemetryMeta: (_symbol, _action, _tradeMode, base = {}, extra = {}) => ({ ...base, ...extra }),
  });
}

export async function runHephaestosExecutionAgentPlanSmoke({ json = false } = {}) {
  const defaults = buildHephaestosExecutionAgentPlan({
    enabled: {
      normal_to_validation_fallback: true,
      validation_live_reentry_softening: true,
    },
  });
  assert.equal(defaults.normalToValidationFallbackEnabled, true);
  assert.equal(defaults.validationLiveReentrySofteningEnabled, true);
  assert.equal(defaults.features.pre_trade_check, true);
  assert.equal(defaults.features.live_fire_cap, true);

  const immutable = buildHephaestosExecutionAgentPlan({
    agentPlan: {
      execution: {
        disabledFeatures: ['pre_trade_check', 'live_fire_cap'],
      },
    },
    enabled: {
      normal_to_validation_fallback: true,
      validation_live_reentry_softening: true,
    },
  });
  assert.equal(immutable.features.pre_trade_check, true);
  assert.equal(immutable.features.live_fire_cap, true);
  assert.equal(immutable.warnings.includes('immutable_execution_feature:pre_trade_check'), true);
  assert.equal(immutable.warnings.includes('immutable_execution_feature:live_fire_cap'), true);

  const riskPolicy = buildRiskPolicy({
    firstCheck: { allowed: false, circuit: false, reason: '최대 포지션 도달: 5/5' },
    validationCheck: { allowed: true },
  });
  const fallbackAllowed = await riskPolicy.resolveBuyExecutionMode({
    persistFailure: async () => {},
    signalId: 'sig-allowed',
    symbol: 'APE/USDT',
    action: 'BUY',
    amountUsdt: 100,
    signalTradeMode: 'normal',
    globalPaperMode: false,
    capitalPolicy: { max_concurrent_positions: 5 },
  });
  assert.equal(fallbackAllowed.effectiveTradeMode, 'validation');

  const persistCalls = [];
  const fallbackDisabled = await riskPolicy.resolveBuyExecutionMode({
    persistFailure: async (reason, meta) => persistCalls.push({ reason, meta }),
    signalId: 'sig-disabled',
    symbol: 'APE/USDT',
    action: 'BUY',
    amountUsdt: 100,
    signalTradeMode: 'normal',
    globalPaperMode: false,
    capitalPolicy: { max_concurrent_positions: 5 },
    agentPlan: {
      execution: {
        disabledFeatures: ['normal_to_validation_fallback'],
      },
    },
  });
  assert.equal(fallbackDisabled.success, false);
  assert.equal(persistCalls[0]?.meta?.code, 'capital_guard_rejected');

  const reentryPolicy = buildReentryPolicy();
  const reentrySoftened = await reentryPolicy.checkBuyReentryGuards({
    persistFailure: async () => {},
    symbol: 'APE/USDT',
    action: 'BUY',
    signalTradeMode: 'validation',
    effectivePaperMode: false,
  });
  assert.equal(reentrySoftened.softGuardApplied, true);
  assert.equal(reentrySoftened.reducedAmountMultiplier, 0.4);

  const reentryBlocked = await reentryPolicy.checkBuyReentryGuards({
    persistFailure: async () => {},
    symbol: 'APE/USDT',
    action: 'BUY',
    signalTradeMode: 'validation',
    effectivePaperMode: false,
    agentPlan: {
      execution: {
        disabledFeatures: ['validation_live_reentry_softening'],
      },
    },
  });
  assert.equal(reentryBlocked.success, false);
  assert.equal(reentryBlocked.code, 'live_position_reentry_blocked');

  const summary = {
    ok: true,
    checked: 6,
    optionalFeatures: ['normal_to_validation_fallback', 'validation_live_reentry_softening'],
    immutableFeatures: ['pre_trade_check', 'capital_backpressure', 'position_sizing', 'live_fire_cap'],
  };
  if (json) return summary;
  return { ...summary, text: 'hephaestos execution agent plan smoke ok' };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runHephaestosExecutionAgentPlanSmoke({ json: process.argv.includes('--json') }),
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[hephaestos-execution-agent-plan-smoke]',
  });
}
