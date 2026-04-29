#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  isAgentMemoryModeAtLeast,
  resolveAgentMemoryRuntimeFlags,
} from '../shared/agent-memory-runtime.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ENV_KEYS = [
  'LUNA_AGENT_MEMORY_MODE',
  'LUNA_AGENT_LEARNING_MODE',
  'LUNA_AGENT_MEMORY_LAYER_1',
  'LUNA_AGENT_LAYER1_WORKING_MEMORY_ENABLED',
  'LUNA_AGENT_MEMORY_AUTO_PREFIX',
  'LUNA_AGENT_PERSONA_ENABLED',
  'LUNA_AGENT_CONSTITUTION_ENABLED',
  'LUNA_AGENT_MEMORY_LAYER_2',
  'LUNA_AGENT_MEMORY_LAYER_3',
  'LUNA_AGENT_MEMORY_LAYER_4',
  'LUNA_AGENT_LLM_ROUTING_ENABLED',
  'LUNA_AGENT_REFLEXION_AUTO_AVOID',
  'LUNA_AGENT_CURRICULUM_ENABLED',
  'LUNA_AGENT_CROSS_BUS_ENABLED',
];

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] == null) delete process.env[key];
    else process.env[key] = snapshot[key] as string;
  }
}

async function runSmoke() {
  const backup = snapshotEnv();
  try {
    for (const key of ENV_KEYS) delete process.env[key];

    let flags = resolveAgentMemoryRuntimeFlags();
    assert.equal(flags.mode, 'off', 'default mode remains fail-closed');
    assert.equal(flags.memoryAutoPrefix, false, 'auto prefix default false');

    process.env.LUNA_AGENT_LEARNING_MODE = 'shadow';
    flags = resolveAgentMemoryRuntimeFlags();
    assert.equal(flags.mode, 'shadow', 'documented learning mode alias is accepted');
    assert.equal(isAgentMemoryModeAtLeast('shadow'), true, 'mode comparator accepts shadow');
    assert.equal(isAgentMemoryModeAtLeast('supervised_l4'), false, 'shadow is below supervised_l4');

    process.env.LUNA_AGENT_MEMORY_MODE = 'autonomous_l5';
    flags = resolveAgentMemoryRuntimeFlags();
    assert.equal(flags.mode, 'autonomous_l5', 'memory mode takes precedence over learning mode');
    assert.equal(isAgentMemoryModeAtLeast('supervised_l4'), true, 'autonomous_l5 >= supervised_l4');

    process.env.LUNA_AGENT_MEMORY_LAYER_1 = 'true';
    flags = resolveAgentMemoryRuntimeFlags();
    assert.equal(flags.layer1WorkingMemoryEnabled, true, 'documented layer1 alias is accepted');

    process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = 'true';
    process.env.LUNA_AGENT_PERSONA_ENABLED = 'true';
    process.env.LUNA_AGENT_CONSTITUTION_ENABLED = 'true';
    process.env.LUNA_AGENT_MEMORY_LAYER_2 = 'true';
    process.env.LUNA_AGENT_MEMORY_LAYER_3 = 'true';
    process.env.LUNA_AGENT_MEMORY_LAYER_4 = 'true';
    process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
    process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID = 'true';
    process.env.LUNA_AGENT_CURRICULUM_ENABLED = 'true';
    process.env.LUNA_AGENT_CROSS_BUS_ENABLED = 'true';
    flags = resolveAgentMemoryRuntimeFlags();
    assert.equal(flags.memoryAutoPrefix, true, 'auto prefix explicit flag');
    assert.equal(flags.personaEnabled, true, 'persona explicit flag');
    assert.equal(flags.constitutionEnabled, true, 'constitution explicit flag');
    assert.equal(flags.layer2ShortTermEnabled, true, 'layer2 explicit flag');
    assert.equal(flags.layer3EpisodicEnabled, true, 'layer3 explicit flag');
    assert.equal(flags.layer4SemanticProceduralEnabled, true, 'layer4 explicit flag');
    assert.equal(flags.llmRoutingEnabled, true, 'routing explicit flag');
    assert.equal(flags.reflexionAutoAvoidEnabled, true, 'reflexion explicit flag');
    assert.equal(flags.curriculumEnabled, true, 'curriculum explicit flag');
    assert.equal(flags.crossBusEnabled, true, 'cross bus explicit flag');

    return { ok: true, mode: flags.mode, layer1WorkingMemoryEnabled: flags.layer1WorkingMemoryEnabled };
  } finally {
    restoreEnv(backup);
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-runtime-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-runtime-smoke 실패:',
  });
}
