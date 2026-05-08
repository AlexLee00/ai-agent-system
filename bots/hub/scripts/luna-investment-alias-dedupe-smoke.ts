#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function main(): void {
  const activeTargets = selector.listAgentModelTargets();
  const investmentAgents = selector.listAgentModelTargets('investment');
  const lunaAliases = selector.listAgentModelTargets('luna');
  const allTargets = selector.listLlmRouteTargets({ includeInternal: true, includeAliases: true });

  assert.equal(activeTargets.some((target: any) => target.team === 'luna'), false, 'global active inventory must not count luna aliases');
  assert.equal(investmentAgents.length, 20, 'investment canonical team must expose the 20 Luna YAML agents');
  assert(lunaAliases.length > investmentAgents.length, 'luna compatibility lookup should preserve alias-only legacy targets');
  assert(lunaAliases.every((target: any) => target.kind === 'alias'), 'luna team lookup must return alias targets only');
  assert(lunaAliases.every((target: any) => target.canonicalTeam === 'investment'), 'luna aliases must point to investment canonical team');
  assert.equal(
    allTargets.filter((target: any) => target.team === 'luna' && target.kind !== 'alias').length,
    0,
    'luna namespace must not contain countable active targets',
  );

  console.log(JSON.stringify({
    ok: true,
    active_targets: activeTargets.length,
    investment_agents: investmentAgents.length,
    luna_alias_targets: lunaAliases.length,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[luna-investment-alias-dedupe-smoke] failed:', error?.message || error);
  process.exit(1);
}
