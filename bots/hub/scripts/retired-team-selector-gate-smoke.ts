#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function main(): void {
  const retiredCases = [
    { callerTeam: 'worker', agent: 'lead', selectorKey: 'worker._default' },
    { callerTeam: 'video', agent: 'edi', selectorKey: 'video-edi.render' },
    { callerTeam: 'edi', agent: 'publisher', selectorKey: 'edi._default' },
    { callerTeam: 'hub', agent: 'openclaw-gateway', selectorKey: 'openclaw.gateway' },
  ];

  for (const testCase of retiredCases) {
    const result = selector.isLlmRouteTargetAllowed(testCase);
    assert.equal(result.ok, false, `${testCase.callerTeam}/${testCase.agent} must be blocked`);
    assert.equal(result.target.kind, 'retired', `${testCase.callerTeam}/${testCase.agent} must classify as retired`);
    assert.equal(result.error, 'retired_llm_target');
  }

  const activeTargets = selector.listLlmRouteTargets({ includeInternal: true, includeAliases: true, includeBlocked: true });
  assert.equal(
    activeTargets.filter((target: any) => target.kind === 'retired').length,
    0,
    'active selector registry must not contain retired worker/video/edi/openclaw targets',
  );

  console.log(JSON.stringify({
    ok: true,
    retired_cases: retiredCases.length,
    active_retired_targets: 0,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[retired-team-selector-gate-smoke] failed:', error?.message || error);
  process.exit(1);
}
