#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { resolveHubRoutingPlan } from '../shared/agent-llm-routing.ts';
import { buildMemoryPrefix } from '../shared/agent-memory-orchestrator.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { buildAgentMemoryDoctorReport } from './runtime-agent-memory-doctor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';

function withEnv(patch, fn) {
  const prev = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

async function runSmoke() {
  const incidentKey = `operational-smoke:${Date.now()}`;
  return withEnv({
    LUNA_AGENT_LEARNING_MODE: 'shadow',
    LUNA_AGENT_MEMORY_AUTO_PREFIX: 'true',
    LUNA_AGENT_PERSONA_ENABLED: 'true',
    LUNA_AGENT_CONSTITUTION_ENABLED: 'true',
      LUNA_AGENT_LLM_ROUTING_ENABLED: 'true',
      LUNA_AGENT_MEMORY_LAYER_1: 'true',
    }, async () => {
      try {
        const agents = [
          { agent: 'luna', market: 'crypto', task: 'final_decision' },
          { agent: 'sophia', market: 'crypto', task: 'sentiment' },
          { agent: 'argos', market: 'crypto', task: 'screening' },
          { agent: 'oracle', market: 'crypto', task: 'onchain' },
          { agent: 'hermes', market: 'crypto', task: 'sentiment' },
        ];

        const results = [];
        for (const item of agents) {
          const route = resolveHubRoutingPlan(item.agent, item.market, item.task, 256);
          assert.equal(route.enabled, true, `${item.agent} route enabled`);
          assert.ok(route.route?.primary, `${item.agent} primary route`);
          const memory = await buildMemoryPrefix({
            agentName: item.agent,
            market: item.market,
            taskType: item.task,
            symbol: 'BTC/USDT',
            maxPrefixChars: 1600,
          });
          assert.ok(memory.layers.persona, `${item.agent} persona loaded`);
          assert.ok(memory.layers.constitution, `${item.agent} constitution loaded`);
          assert.ok(memory.layers.workingState, `${item.agent} working state loaded`);
          assert.ok(memory.totalChars <= 1700, `${item.agent} prefix budget respected`);
          await recordInvestmentLlmRouteLog({
            agentName: item.agent,
            provider: route.chain?.[0]?.provider || route.route.primary,
            ok: true,
            market: item.market,
            taskType: item.task,
            latencyMs: 1,
            incidentKey,
            routeChain: route.chain,
          });
          results.push({ ...item, primary: route.route.primary, prefixChars: memory.totalChars });
        }

        const doctor = await buildAgentMemoryDoctorReport({ market: 'crypto', strict: false });
        assert.equal(doctor.ok, true, 'doctor remains ok');
        assert.ok(doctor.recentRoutes?.length >= 1, 'route log visible to doctor');

        const oldAuto = process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
        const oldPersona = process.env.LUNA_AGENT_PERSONA_ENABLED;
        const oldConstitution = process.env.LUNA_AGENT_CONSTITUTION_ENABLED;
        const oldLayer4 = process.env.LUNA_AGENT_MEMORY_LAYER_4;
        process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = 'false';
        process.env.LUNA_AGENT_PERSONA_ENABLED = 'false';
        process.env.LUNA_AGENT_CONSTITUTION_ENABLED = 'false';
        process.env.LUNA_AGENT_MEMORY_LAYER_4 = 'false';
        try {
          const kisMemory = await buildMemoryPrefix({
            agentName: 'luna',
            market: 'kis',
            taskType: 'final_decision',
            symbol: '417840',
            workingState: 'fixture KIS final_decision working state',
            maxPrefixChars: 2400,
          });
          assert.ok(kisMemory.totalChars > 0, 'KIS final_decision force memory prefix enabled');
          assert.ok(kisMemory.layers.persona, 'KIS final_decision persona forced');
          assert.ok(kisMemory.layers.constitution, 'KIS final_decision constitution forced');
          assert.ok(kisMemory.layers.skills >= 1, 'KIS final_decision procedural memory forced');
          assert.ok(kisMemory.layers.failures >= 1, 'KIS final_decision failure pattern forced');
          assert.ok(kisMemory.layers.workingState, 'KIS final_decision working state forced');
          assert.match(kisMemory.prefix, /KIS_STRATEGY_IMPROVEMENT|KIS_FAILURE_PATTERN/);
        } finally {
          if (oldAuto === undefined) delete process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX;
          else process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX = oldAuto;
          if (oldPersona === undefined) delete process.env.LUNA_AGENT_PERSONA_ENABLED;
          else process.env.LUNA_AGENT_PERSONA_ENABLED = oldPersona;
          if (oldConstitution === undefined) delete process.env.LUNA_AGENT_CONSTITUTION_ENABLED;
          else process.env.LUNA_AGENT_CONSTITUTION_ENABLED = oldConstitution;
          if (oldLayer4 === undefined) delete process.env.LUNA_AGENT_MEMORY_LAYER_4;
          else process.env.LUNA_AGENT_MEMORY_LAYER_4 = oldLayer4;
        }

        return { ok: true, agents: results.length, doctorStatus: doctor.status };
      } finally {
        await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [incidentKey]).catch(() => null);
      }
    });
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-operational-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-operational-smoke 실패:',
  });
}
