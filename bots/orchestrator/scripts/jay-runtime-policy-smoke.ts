#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const {
  getJayBudgetPolicy,
  getJayGrowthPolicy,
} = require('../lib/jay-runtime-policy.ts');

const disabled = getJayGrowthPolicy({}, {});
assert.equal(disabled.serviceLabel, 'ai.jay.growth');
assert.equal(disabled.enabled, false);
assert.match(disabled.disabledReason, /master_decision/);

const enabled = getJayGrowthPolicy({ JAY_GROWTH_ENABLED: 'true' }, {});
assert.equal(enabled.enabled, true);
assert.equal(enabled.disabledReason, '');

const budget = getJayBudgetPolicy({ JAY_LLM_DAILY_BUDGET_USD: '5.0' }, {});
assert.equal(budget.dailyBudgetUsd, 5.0);
assert.equal(budget.source, 'env');

console.log('jay_runtime_policy_smoke_ok');
