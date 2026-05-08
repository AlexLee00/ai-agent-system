#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function kind(team: string, agent: string, selectorKey?: string): string {
  return selector.classifyLlmRouteTarget(team, agent, selectorKey || `${team}.${agent}`).kind;
}

function main(): void {
  assert.equal(kind('blog', 'pos', 'blog.pos.writer'), 'visible_agent');
  assert.equal(kind('blog', 'social-caption', 'blog.social.caption'), 'task_route');
  assert.equal(kind('ska', 'jimmy', 'ska.classify'), 'visible_agent');
  assert.equal(kind('ska', 'error-classifier', 'ska.classify'), 'task_route');
  assert.equal(kind('sigma', 'commander', 'sigma.agent_policy'), 'visible_agent');
  assert.equal(kind('sigma', 'skill.data_quality', 'sigma.agent_policy'), 'task_route');
  assert.equal(kind('darwin', 'darwin.planner', 'darwin.agent_policy'), 'visible_agent');
  assert.equal(kind('darwin', 'planner', 'darwin.agent_policy'), 'alias');
  assert.equal(kind('orchestrator', 'summary', 'orchestrator.jay.summary'), 'runtime_service');
  assert.equal(kind('core', 'chunked-default', 'core.chunked.default'), 'task_route');
  assert.equal(kind('legal', 'justin', 'legal._default'), 'pending_runtime');
  assert.equal(kind('worker', 'lead', 'worker._default'), 'retired');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'visible_agent',
      'task_route',
      'alias',
      'runtime_service',
      'pending_runtime',
      'retired',
    ],
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-route-target-classification-smoke] failed:', error?.message || error);
  process.exit(1);
}
