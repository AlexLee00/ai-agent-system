#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function countByKind(targets: any[]): Record<string, number> {
  return targets.reduce((acc, target) => {
    const kind = String(target?.kind || 'unknown');
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function main(): void {
  assert.equal(typeof selector.listLlmRouteTargets, 'function', 'selector must expose route target inventory');
  assert.equal(typeof selector.listAgentModelTargets, 'function', 'selector must expose active agent/runtime inventory');

  const allTargets = selector.listLlmRouteTargets({ includeInternal: true, includeAliases: true, includeBlocked: true });
  const activeTargets = selector.listAgentModelTargets();
  const visibleAgents = activeTargets.filter((target: any) => target.kind === 'visible_agent');
  const runtimeServices = activeTargets.filter((target: any) => target.kind === 'runtime_service');
  const counts = countByKind(allTargets);

  assert(allTargets.length > activeTargets.length, 'route target inventory must keep internal routes separate from active targets');
  assert(visibleAgents.length > 0, 'visible agent inventory must not be empty');
  assert(runtimeServices.length > 0, 'active runtime service inventory must not be empty');
  assert(
    activeTargets.every((target: any) => target.kind === 'visible_agent' || target.kind === 'runtime_service'),
    'default active inventory must only include visible agents and active runtime services',
  );
  assert(!activeTargets.some((target: any) => target.team === 'luna'), 'luna alias namespace must not inflate active target count');
  assert((counts.task_route || 0) > 0, 'task routes must be classified separately');
  assert((counts.alias || 0) > 0, 'alias routes must be classified separately');
  assert((counts.runtime_service || 0) > 0, 'runtime service routes must be classified separately');
  assert.equal(counts.retired || 0, 0, 'retired teams must not be present in active selector inventory');

  console.log(JSON.stringify({
    ok: true,
    all_targets: allTargets.length,
    visible_agents: visibleAgents.length,
    active_runtime_services: runtimeServices.length,
    active_targets: activeTargets.length,
    by_kind: counts,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[agent-inventory-audit-smoke] failed:', error?.message || error);
  process.exit(1);
}
