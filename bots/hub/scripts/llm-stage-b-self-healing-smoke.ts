#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSelfHealingPlan } = require('../lib/stage-b/stability.ts');

const fixture = {
  protected: {
    missing: ['ai.hub.resource-api'],
    idleExitWarnings: [
      {
        label: 'ai.hub.weekly-advisory-digest',
        exitStatus: '1',
        diagnostic: {
          dryRunCommand: 'npm --prefix bots/hub run -s alarm:weekly-advisory-digest:dry-run',
          tailCommand: 'tail -n 120 /tmp/hub-weekly-advisory-digest.err.log',
        },
      },
    ],
  },
  circuits: {
    nonClosed: 2,
  },
  budget: {
    emergency: true,
  },
  requestLog: {
    ok: false,
  },
  sentry: {
    mode: 'adapter_ready_config_pending',
  },
};

const plan = buildSelfHealingPlan(fixture);
assert.equal(plan.mode, 'read_only_by_default');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'tier_probe'), 'tier probe should be safe read-only recovery');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'request_log_diagnostics'), 'request log diagnostics should be read-only');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'expected_idle_exit_status_review' && item.command.includes('weekly-advisory-digest:dry-run')), 'expected-idle warnings should provide dry-run verification');
assert(plan.confirmRequiredActions.some((item) => item.action === 'protected_service_recovery'), 'protected service recovery must require confirmation');
assert(plan.confirmRequiredActions.some((item) => item.action === 'billing_guard_review'), 'BillingGuard emergency must require review');
assert(plan.prohibitedActions.some((item) => /kickstart|kill|unload/.test(item)), 'protected restart/kill/unload must be prohibited');

const unsafeCommands = [
  ...plan.safeReadOnlyActions.map((item) => item.command || ''),
].filter((command) => /\b(kill|bootout|unload|kickstart\s+-k)\b/.test(command));
assert.deepEqual(unsafeCommands, [], 'safe actions must never contain protected mutation commands');

console.log(JSON.stringify({
  ok: true,
  stage: 'hub_stage_b',
  safe_actions: plan.safeReadOnlyActions.length,
  confirm_required: plan.confirmRequiredActions.length,
  prohibited: plan.prohibitedActions.length,
}, null, 2));
