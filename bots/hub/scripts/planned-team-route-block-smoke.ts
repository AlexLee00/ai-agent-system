#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
}

function assertBlocked(team: string, expectedKind: string): void {
  const result = selector.isLlmRouteTargetAllowed({ callerTeam: team, agent: 'default', selectorKey: `${team}._default` });
  assert.equal(result.ok, false, `${team} must be blocked by default`);
  assert.equal(result.target.kind, expectedKind, `${team} must classify as ${expectedKind}`);
}

function main(): void {
  withEnv('HUB_ALLOW_PLANNED_LLM_ROUTES', undefined, () => {
    for (const team of ['secretary', 'business', 'academic']) assertBlocked(team, 'planned');
    assertBlocked('legal', 'pending_runtime');
  });

  withEnv('HUB_ALLOW_PLANNED_LLM_ROUTES', 'true', () => {
    for (const team of ['secretary', 'business', 'academic', 'legal']) {
      const result = selector.isLlmRouteTargetAllowed({ callerTeam: team, agent: 'default', selectorKey: `${team}._default` });
      assert.equal(result.ok, true, `${team} may only be allowed behind HUB_ALLOW_PLANNED_LLM_ROUTES`);
    }
    const retired = selector.isLlmRouteTargetAllowed({ callerTeam: 'worker', agent: 'lead', selectorKey: 'worker._default' });
    assert.equal(retired.ok, false, 'retired teams must remain blocked even when planned routes are allowed');
  });

  console.log(JSON.stringify({
    ok: true,
    planned_blocked_by_default: ['secretary', 'business', 'academic'],
    pending_runtime_blocked_by_default: ['legal'],
    planned_override_env: 'HUB_ALLOW_PLANNED_LLM_ROUTES',
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[planned-team-route-block-smoke] failed:', error?.message || error);
  process.exit(1);
}
