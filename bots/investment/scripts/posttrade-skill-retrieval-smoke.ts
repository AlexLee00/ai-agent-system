#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { buildMemoryPrefix } from '../shared/agent-memory-orchestrator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const patternKey = `crypto:smoke_breakout:bull:long:${Date.now()}`;
  const upserted = await db.upsertPosttradeSkill({
    market: 'crypto',
    agentName: 'luna',
    skillType: 'success',
    patternKey,
    title: `SUCCESS ${patternKey}`,
    summary: 'smoke posttrade skill retrieval',
    invocationCount: 999999,
    successRate: 1,
    winCount: 999999,
    lossCount: 0,
    sourceTradeIds: [101, 102, 103],
    metadata: { smoke: true },
  });
  assert.ok(upserted?.id, 'posttrade skill inserted');

  const oldAuto = process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
  const oldLayer4 = process.env.LUNA_AGENT_MEMORY_LAYER_4;
  process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = 'true';
  process.env.LUNA_AGENT_MEMORY_LAYER_4 = 'true';
  try {
    const memory = await buildMemoryPrefix({
      agentName: 'luna',
      market: 'crypto',
      taskType: 'entry',
      symbol: 'BTC/USDT',
      maxPrefixChars: 4000,
    });
    assert.ok(memory.prefix.includes('POSTTRADE_SKILL'), 'prefix includes DB posttrade skill marker');
    assert.ok(memory.prefix.includes(patternKey), 'prefix includes inserted pattern key');
    assert.ok(memory.layers.skills >= 1, 'skill layer counted');
    return {
      ok: true,
      skillId: upserted.id,
      patternKey,
      skillLayerCount: memory.layers.skills,
    };
  } finally {
    if (oldAuto === undefined) delete process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
    else process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = oldAuto;
    if (oldLayer4 === undefined) delete process.env.LUNA_AGENT_MEMORY_LAYER_4;
    else process.env.LUNA_AGENT_MEMORY_LAYER_4 = oldLayer4;
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-skill-retrieval-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-skill-retrieval-smoke 실패:',
  });
}
