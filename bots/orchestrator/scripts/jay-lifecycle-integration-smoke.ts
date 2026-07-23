#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const lifecycle = require('../../../packages/core/lib/agent-lifecycle.ts');
const runtime = require('../src/jay-runtime.ts');

async function main() {
  const persona = lifecycle.loadPersona('jay');
  assert.ok(persona.length > 0, 'Jay persona must be loadable');
  assert.ok(persona.length <= 600, 'Jay persona summary must remain bounded');

  const previous = process.env.JAY_LIFECYCLE_INJECT_ENABLED;
  delete process.env.JAY_LIFECYCLE_INJECT_ENABLED;
  assert.equal(runtime.resolveOrchestrationConfig().lifecycleInject, false);
  process.env.JAY_LIFECYCLE_INJECT_ENABLED = 'true';
  assert.equal(runtime.resolveOrchestrationConfig().lifecycleInject, true);
  if (previous == null) delete process.env.JAY_LIFECYCLE_INJECT_ENABLED;
  else process.env.JAY_LIFECYCLE_INJECT_ENABLED = previous;

  let received = null;
  const context = await runtime._testOnly.buildJayLifecycleContext({
    incident: { incidentKey: 'jay:lifecycle:smoke', team: 'hub', intent: 'health_check' },
    goal: 'verify lifecycle context',
    enabled: true,
    lifecycleBuilder: async (input) => {
      received = input;
      return {
        persona,
        recall: { memories: [{ sourceTag: 'vault-entry:jay-persona' }] },
        promptBlock: '<!-- AGENT_LIFECYCLE:BEGIN -->\n[BOOT]\nJay\n<!-- AGENT_LIFECYCLE:END -->',
        injected: true,
      };
    },
  });
  assert.equal(received.team, 'jay');
  assert.equal(received.agent, 'commander');
  assert.equal(received.enabled, true);
  assert.match(received.topic, /hub health_check verify lifecycle context/);
  assert.equal(context.injected, true);

  const legacyMessage = runtime._testOnly.buildPlannerMessage('goal', 'skills', '');
  assert.equal(legacyMessage, 'goal\n\nskills', 'disabled lifecycle must preserve the previous planner message');
  const injectedMessage = runtime._testOnly.buildPlannerMessage('goal', 'skills', context.promptBlock);
  assert.equal((injectedMessage.match(/AGENT_LIFECYCLE:BEGIN/g) || []).length, 1);

  console.log(JSON.stringify({ ok: true, personaChars: persona.length, lifecycleInjected: context.injected }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
