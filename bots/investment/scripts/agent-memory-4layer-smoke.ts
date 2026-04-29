#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { buildMemoryPrefix, saveShortTermMemory } from '../shared/agent-memory-orchestrator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function seedEpisodic(symbol: string) {
  await db.run(
    `INSERT INTO investment.luna_rag_documents(owner_agent, category, market, symbol, content, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      'luna',
      'thesis',
      'crypto',
      symbol,
      'smoke episodic thesis',
      JSON.stringify({ smoke: true }),
    ],
  ).catch(async () => {
    await db.run(
      `INSERT INTO investment.luna_rag_documents(category, market, symbol, content, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      ['thesis', 'crypto', symbol, 'smoke episodic thesis', JSON.stringify({ smoke: true })],
    ).catch(() => {});
  });
}

async function runSmoke() {
  await db.initSchema();
  const symbol = 'BTC/USDT';

  const envBackup = {
    auto: process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX,
    persona: process.env.LUNA_AGENT_PERSONA_ENABLED,
    constitution: process.env.LUNA_AGENT_CONSTITUTION_ENABLED,
    l2: process.env.LUNA_AGENT_MEMORY_LAYER_2,
    l3: process.env.LUNA_AGENT_MEMORY_LAYER_3,
    l4: process.env.LUNA_AGENT_MEMORY_LAYER_4,
    curriculum: process.env.LUNA_AGENT_CURRICULUM_ENABLED,
  };

  process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = 'true';
  process.env.LUNA_AGENT_PERSONA_ENABLED = 'true';
  process.env.LUNA_AGENT_CONSTITUTION_ENABLED = 'true';
  process.env.LUNA_AGENT_MEMORY_LAYER_2 = 'true';
  process.env.LUNA_AGENT_MEMORY_LAYER_3 = 'true';
  process.env.LUNA_AGENT_MEMORY_LAYER_4 = 'true';
  process.env.LUNA_AGENT_CURRICULUM_ENABLED = 'true';

  await saveShortTermMemory('luna', { note: 'short term smoke' }, { symbol, market: 'crypto', incidentKey: 'mem-smoke' });
  await seedEpisodic(symbol);
  await db.run(
    `INSERT INTO investment.entity_facts(entity, fact, confidence, source)
     VALUES ($1,$2,$3,$4)`,
    [symbol, 'smoke fact: high liquidity', 0.91, 'smoke'],
  ).catch(() => {});
  await db.upsertPosttradeSkill({
    market: 'crypto',
    agentName: 'luna',
    skillType: 'success',
    patternKey: `crypto:mem_smoke:${Date.now()}`,
    title: 'SUCCESS memory smoke',
    summary: 'memory smoke skill',
    invocationCount: 10,
    successRate: 0.9,
    winCount: 9,
    lossCount: 1,
    sourceTradeIds: [900001],
    metadata: { smoke: true },
  });

  const result = await buildMemoryPrefix({
    agentName: 'luna',
    market: 'crypto',
    symbol,
    taskType: 'final_decision',
    incidentKey: 'mem-smoke',
    workingState: 'working-state smoke',
    maxPrefixChars: 8000,
  });

  assert.ok(result.prefix.length > 0, 'prefix generated');
  assert.equal(result.layers.persona, true, 'persona loaded');
  assert.equal(result.layers.constitution, true, 'constitution loaded');
  assert.ok(result.layers.shortTerm >= 1, 'layer2 short-term loaded');
  assert.ok(result.layers.episodic >= 1, 'layer3 episodic loaded');
  assert.ok(result.layers.skills >= 1, 'layer4 skill loaded');
  assert.ok(result.layers.entityFacts >= 1, 'layer4 entity fact loaded');
  assert.equal(result.layers.workingState, true, 'working state injected');

  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[
      k === 'auto' ? 'LUNA_AGENT_MEMORY_AUTO_PREFIX'
        : k === 'persona' ? 'LUNA_AGENT_PERSONA_ENABLED'
          : k === 'constitution' ? 'LUNA_AGENT_CONSTITUTION_ENABLED'
            : k === 'l2' ? 'LUNA_AGENT_MEMORY_LAYER_2'
              : k === 'l3' ? 'LUNA_AGENT_MEMORY_LAYER_3'
                : k === 'l4' ? 'LUNA_AGENT_MEMORY_LAYER_4'
                  : 'LUNA_AGENT_CURRICULUM_ENABLED'
    ];
    else process.env[
      k === 'auto' ? 'LUNA_AGENT_MEMORY_AUTO_PREFIX'
        : k === 'persona' ? 'LUNA_AGENT_PERSONA_ENABLED'
          : k === 'constitution' ? 'LUNA_AGENT_CONSTITUTION_ENABLED'
            : k === 'l2' ? 'LUNA_AGENT_MEMORY_LAYER_2'
              : k === 'l3' ? 'LUNA_AGENT_MEMORY_LAYER_3'
                : k === 'l4' ? 'LUNA_AGENT_MEMORY_LAYER_4'
                  : 'LUNA_AGENT_CURRICULUM_ENABLED'
    ] = v as string;
  }

  return {
    ok: true,
    layers: result.layers,
    totalChars: result.totalChars,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-4layer-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-4layer-smoke 실패:',
  });
}

