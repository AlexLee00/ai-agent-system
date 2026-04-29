#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { buildMemoryPrefix } from '../shared/agent-memory-orchestrator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const tag = Date.now();
  const basePattern = `crypto:agent_skill_smoke:${tag}`;

  await db.upsertPosttradeSkill({
    market: 'crypto',
    agentName: 'all',
    skillType: 'success',
    patternKey: `${basePattern}:all`,
    title: 'SUCCESS shared skill',
    summary: 'shared fallback skill',
    invocationCount: 10,
    successRate: 0.8,
    winCount: 8,
    lossCount: 2,
    sourceTradeIds: [910001],
    metadata: { smoke: true, scope: 'shared' },
  });

  await db.upsertPosttradeSkill({
    market: 'crypto',
    agentName: 'luna',
    skillType: 'success',
    patternKey: `${basePattern}:luna`,
    title: 'SUCCESS luna skill',
    summary: 'luna specific skill',
    invocationCount: 10,
    successRate: 0.95,
    winCount: 9,
    lossCount: 1,
    sourceTradeIds: [910002],
    metadata: { smoke: true, scope: 'agent' },
  });

  const oldAuto = process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
  const oldLayer4 = process.env.LUNA_AGENT_MEMORY_LAYER_4;
  process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = 'true';
  process.env.LUNA_AGENT_MEMORY_LAYER_4 = 'true';

  const memory = await buildMemoryPrefix({
    agentName: 'luna',
    market: 'crypto',
    taskType: 'final_decision',
    symbol: 'BTC/USDT',
    maxPrefixChars: 5000,
  });

  if (oldAuto === undefined) delete process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
  else process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = oldAuto;
  if (oldLayer4 === undefined) delete process.env.LUNA_AGENT_MEMORY_LAYER_4;
  else process.env.LUNA_AGENT_MEMORY_LAYER_4 = oldLayer4;

  assert.ok(memory.prefix.includes('POSTTRADE_SKILL/crypto/luna/success') || memory.prefix.includes(':luna'), 'agent specific skill preferred');

  return {
    ok: true,
    skillLayer: memory.layers.skills,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-skill-market-retrieval-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-skill-market-retrieval-smoke 실패:',
  });
}

