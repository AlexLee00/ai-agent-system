#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildLunaDynamicPolicyOperator } from './runtime-luna-dynamic-policy-operator.ts';

const saved = {
  LUNA_DYNAMIC_POLICY_ENABLED: process.env.LUNA_DYNAMIC_POLICY_ENABLED,
  LUNA_DYNAMIC_POLICY_AUTO_APPLY_ENABLED: process.env.LUNA_DYNAMIC_POLICY_AUTO_APPLY_ENABLED,
  LUNA_DYNAMIC_POLICY_ALLOW_BEARISH_PROBE: process.env.LUNA_DYNAMIC_POLICY_ALLOW_BEARISH_PROBE,
};

try {
  process.env.LUNA_DYNAMIC_POLICY_ENABLED = 'true';
  process.env.LUNA_DYNAMIC_POLICY_AUTO_APPLY_ENABLED = 'true';
  process.env.LUNA_DYNAMIC_POLICY_ALLOW_BEARISH_PROBE = 'false';

  const result = await buildLunaDynamicPolicyOperator({ days: 14, apply: false });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(Array.isArray(result.candidates), true);
  assert.equal(Array.isArray(result.blocked), true);
  assert.ok(result.reports.crypto, 'crypto dynamic policy report should be present');
  assert.ok(result.reports.domestic, 'domestic dynamic policy report should be present');
  assert.ok(result.reports.overseas, 'overseas dynamic policy report should be present');
  assert.equal(result.marketSessions.crypto.isOpen, true);
  assert.equal(result.marketSessions.crypto.sessionPolicy, 'continuous_24h');
  assert.ok(result.marketSessions.domestic.sessionPolicy, 'domestic session policy should be present');
  assert.ok(result.marketSessions.overseas.sessionPolicy, 'overseas session policy should be present');
  for (const blocked of result.blocked) {
    if (blocked.reason === 'probe_deferred_until_market_open') {
      assert.notEqual(blocked.market, 'crypto');
      assert.equal(blocked.session?.isOpen, false);
    }
  }

  const blockedApply = await buildLunaDynamicPolicyOperator({ days: 14, apply: true, confirm: 'wrong-confirm' });
  if (blockedApply.candidates.length > 0) {
    assert.equal(blockedApply.ok, false);
    assert.equal(blockedApply.status, 'luna_dynamic_policy_apply_blocked_confirm_required');
  } else {
    assert.notEqual(blockedApply.status, 'luna_dynamic_policy_applied');
  }

  const disabledSaved = process.env.LUNA_DYNAMIC_POLICY_ENABLED;
  process.env.LUNA_DYNAMIC_POLICY_ENABLED = 'false';
  const disabled = await buildLunaDynamicPolicyOperator({ days: 14, apply: false });
  assert.equal(disabled.status, 'luna_dynamic_policy_disabled');
  process.env.LUNA_DYNAMIC_POLICY_ENABLED = disabledSaved;

  console.log(JSON.stringify({
    ok: true,
    status: 'luna_dynamic_policy_operator_smoke_ok',
    candidates: result.candidates.length,
    blocked: result.blocked.length,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
