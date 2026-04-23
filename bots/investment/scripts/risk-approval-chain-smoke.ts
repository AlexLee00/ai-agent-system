#!/usr/bin/env node
// @ts-nocheck

import {
  buildRiskApprovalTarget,
  runRiskApprovalChain,
} from '../shared/risk-approval-chain.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runRiskApprovalChainSmoke() {
  const target = buildRiskApprovalTarget({
    signal: {
      symbol: 'TEST/USDT',
      action: 'BUY',
      amount_usdt: 1200,
      confidence: 0.72,
      exchange: 'binance',
      trade_mode: 'normal',
      analyst_signals: 'A:B|O:B|H:N|S:S',
      reasoning: 'synthetic smoke signal',
    },
    portfolio: {
      totalAsset: 10000,
      positionCount: 2,
      todayPnl: 0,
    },
    marketRegime: { regime: 'trending_bear' },
    feedback: {
      bias: 'downweight_by_win_rate',
      family: 'momentum_rotation',
      winRatePct: 24.2,
    },
    rules: {
      MIN_ORDER_USDT: 10,
      MAX_ORDER_USDT: 1500,
      MAX_SINGLE_POSITION_PCT: 0.1,
      MAX_OPEN_POSITIONS: 6,
    },
  });

  const result = runRiskApprovalChain(target);
  const models = result.steps.map((step) => step.model);
  const hardRule = result.steps.find((step) => step.model === 'hard_rule');
  const regime = result.steps.find((step) => step.model === 'regime_risk');
  const consensus = result.steps.find((step) => step.model === 'consensus_risk');
  const feedback = result.steps.find((step) => step.model === 'feedback_risk');

  assert(result.approved === true, 'expected synthetic target to remain approved');
  assert(models.join('>') === 'hard_rule>regime_risk>consensus_risk>feedback_risk>execution_freshness', `unexpected model order: ${models.join('>')}`);
  assert(hardRule?.amountAfter === 1000, `expected hard-rule cap to 1000, got ${hardRule?.amountAfter}`);
  assert(regime?.amountAfter === 550, `expected bear regime reduce to 550, got ${regime?.amountAfter}`);
  assert(consensus?.decision === 'PASS', `expected consensus pass, got ${consensus?.decision}`);
  assert(feedback?.amountAfter === 484, `expected feedback reduce to 484, got ${feedback?.amountAfter}`);
  assert(result.finalAmount === 484, `expected final amount 484, got ${result.finalAmount}`);

  const rejection = runRiskApprovalChain(buildRiskApprovalTarget({
    signal: {
      symbol: 'RISK/USDT',
      action: 'BUY',
      amount_usdt: 100,
      confidence: 0.4,
      exchange: 'binance',
      analyst_signals: 'A:S|O:S|H:N|S:N',
    },
    portfolio: { totalAsset: 10000, positionCount: 1 },
    rules: {
      MIN_ORDER_USDT: 10,
      MAX_ORDER_USDT: 1000,
      MAX_SINGLE_POSITION_PCT: 0.1,
      MAX_OPEN_POSITIONS: 6,
    },
  }));
  assert(rejection.approved === false, 'expected consensus rejection scenario');
  assert(rejection.steps.at(-1)?.model === 'consensus_risk', `expected consensus rejection, got ${rejection.steps.at(-1)?.model}`);

  return {
    ok: true,
    approvedScenario: result,
    rejectedScenario: rejection,
  };
}

async function main() {
  const result = runRiskApprovalChainSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`risk approval chain smoke ok: ${result.approvedScenario.finalAmount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval chain smoke 실패:',
  });
}
