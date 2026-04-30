#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { listAgentDefinitions, getAgentDefinition } from '../shared/agent-yaml-loader.ts';
import { buildCollaborationMatrix } from '../shared/agent-collaboration-matrix.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const agents = listAgentDefinitions();
  const matrix = buildCollaborationMatrix(agents);
  const elixirShadow = agents.filter((agent) => String(agent.runtime).includes('elixir')).map((agent) => agent.name);
  assert.equal(agents.length, 19, '19 canonical agent YAML files');
  assert.ok(agents.every((agent) => agent.validation.ok), 'all YAML definitions validate');
  assert.ok(getAgentDefinition('kairos'), 'kairos YAML exists');
  assert.deepEqual(elixirShadow.sort(), ['argos', 'aria', 'sentinel', 'stock-flow', 'sweeper'].sort());
  assert.equal(matrix.ok, true, `collaboration matrix ok: ${JSON.stringify(matrix.missingReferences)}`);
  return { ok: true, totalAgents: agents.length, elixirShadow, byTier: matrix.byTier };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ agent-yaml-loader-smoke agents=${result.totalAgents}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ agent-yaml-loader-smoke 실패:' });
}
