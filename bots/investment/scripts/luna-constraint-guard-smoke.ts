#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { getParameterGovernance } from '../shared/runtime-parameter-governance.ts';
import { MARKET_ORDER_RULES } from '../shared/order-rules.ts';
import { setParameter, _testOnly as parameterStoreTestOnly } from '../shared/luna-parameter-store.ts';
import { evaluateLunaAutonomousCommand } from '../shared/luna-autonomous-command-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  assert.equal(getParameterGovernance('order_rules').tier, 'block');
  assert.equal(getParameterGovernance('paper_mode').tier, 'block');
  assert.equal(Object.isFrozen(MARKET_ORDER_RULES), true);
  assert.equal(Object.isFrozen(MARKET_ORDER_RULES.binance), true);
  assert.throws(() => {
    MARKET_ORDER_RULES.binance.minOrderAmount = 1;
  });
  assert.equal(MARKET_ORDER_RULES.binance.minOrderAmount, 10);

  await assert.rejects(
    () => setParameter({ key: 'order_rules', value: 'mutable', changedBy: 'master' }, {
      queryFn: async () => [],
      runFn: async () => {
        throw new Error('runFn_should_not_be_called');
      },
    }),
    /luna_parameter_immutable:order_rules/
  );

  await assert.rejects(
    () => setParameter({ key: 'capital_management.max_daily_loss_pct', value: 0.05, changedBy: 'system' }, {
      queryFn: async () => [],
      runFn: async () => {
        throw new Error('runFn_should_not_be_called');
      },
    }),
    /luna_parameter_approval_required:capital_management\.max_daily_loss_pct/
  );

  assert.equal(parameterStoreTestOnly.governanceToStoreTier({ tier: 'allow' }), 'auto');
  assert.equal(parameterStoreTestOnly.governanceToStoreTier({ tier: 'observe' }), 'auto');
  assert.equal(parameterStoreTestOnly.governanceToStoreTier({ tier: 'unknown' }), 'auto');
  assert.equal(parameterStoreTestOnly.governanceToStoreTier({ tier: 'escalate' }), 'approve');
  assert.equal(parameterStoreTestOnly.governanceToStoreTier({ tier: 'block' }), 'immutable');

  assert.equal(evaluateLunaAutonomousCommand('launchctl setenv LUNA_LIVE_FIRE_ENABLED true').blocked, true);
  assert.equal(evaluateLunaAutonomousCommand('sed -i "" s/foo/bar/ ai.luna.ops-scheduler.plist').blocked, true);
  assert.equal(evaluateLunaAutonomousCommand('plutil -lint ai.luna.ops-scheduler.plist').ok, true);
  assert.equal(evaluateLunaAutonomousCommand('node scripts/apply-runtime-config-suggestion.ts --force').blocked, true);
  assert.equal(evaluateLunaAutonomousCommand('npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json').ok, true);

  return {
    ok: true,
    smoke: 'luna-constraint-guard',
    immutableBlocked: true,
    approveSystemBlocked: true,
    commandPolicy: true,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-constraint-guard-smoke 실패:',
  });
}

export { main as runLunaConstraintGuardSmoke };
