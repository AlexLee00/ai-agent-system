#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  applyProviderRuntimeGuards,
} from '../../../packages/core/lib/llm-model-selector.ts';
import {
  buildEngineDiff,
} from './llm-chain-snapshot.ts';
import {
  normalizePolicyEngineChain,
  resolvePolicyChain,
} from '../../../packages/core/lib/llm-policy-engine.ts';
import {
  buildHubLlmPromotionGateReport,
} from '../lib/hub-llm-promotion-gate.ts';
import {
  runHubLlmPromotionGateRuntime,
} from './runtime-hub-llm-promotion-gate.ts';

const require = createRequire(import.meta.url);
const { resolveHubLlmSelection, selectChainWithShadow } = require('../src/llm-selector.ts');
const results = [];

async function record(id, name, fn) {
  try {
    const evidence = await fn();
    results.push({ id, name, pass: true, evidence: String(evidence || 'ok') });
  } catch (error) {
    results.push({ id, name, pass: false, evidence: error?.stack || error?.message || String(error) });
  }
}

function hasProvider(chain, provider) {
  return normalizePolicyEngineChain(chain).some((entry) => entry.provider === provider);
}

function gateREvidenceQuery({ total = 50, mismatches = 0 } = {}) {
  return async (sql) => {
    if (sql.includes('hub_llm_gate:gate_r_evidence')) {
      return [{ shadow_total_count: total, shadow_mismatch_count: mismatches }];
    }
    throw new Error(`unexpected query in GATE-R smoke: ${sql.slice(0, 100)}`);
  };
}

async function main() {
  await record('TS-R2-1', 'engine full-surface diff is zero', () => {
  const engineDiff = buildEngineDiff();
  assert.equal(engineDiff.total, 408);
  assert.equal(engineDiff.mismatched, 0);
  return `total=${engineDiff.total} mismatched=${engineDiff.mismatched}`;
  });

  await record('TS-R2-2', 'MODE=off does not call policy engine', () => {
  let engineCalls = 0;
  const oldChain = [{ provider: 'old-provider', model: 'old-model', maxTokens: 1, temperature: 0 }];
  const chain = selectChainWithShadow('hub._default', { team: 'hub' }, {
    mode: 'off',
    selectLLMChain: () => oldChain,
    policyEngine: {
      resolvePolicyChain() {
        engineCalls += 1;
        return [];
      },
    },
  });
  assert.equal(engineCalls, 0);
  assert.equal(chain, oldChain);
  return `engineCalls=${engineCalls}`;
  });

  await record('TS-R2-3', 'representative guard outcomes are preserved', () => {
  const backtest = resolvePolicyChain({
    selectorKey: 'chronos.backtest',
    team: 'chronos',
    taskType: 'backtest_embedding',
  });
  assert.deepEqual(backtest, [{
    provider: 'local-embedding',
    model: 'qwen3-embed-0.6b',
    maxTokens: 0,
    temperature: 0,
  }]);

  const darwin = resolvePolicyChain({
    selectorKey: 'darwin.agent_policy',
    team: 'darwin',
    agentName: 'applier',
  });
  assert.equal(hasProvider(darwin, 'gemini-cli-oauth'), false);
  assert.equal(hasProvider(darwin, 'openai-oauth'), true);
  assert.equal(hasProvider(darwin, 'groq'), true);

  const emptyGuarded = applyProviderRuntimeGuards([], { selectorKey: 'fixture.empty' });
  assert.equal(emptyGuarded[0]?.provider, 'openai-oauth');
  assert.equal(emptyGuarded[0]?.model, 'gpt-5.4-mini');
  return 'backtest local-embedding, darwin no-gemini, empty-chain openai mini';
  });

  await record('TS-R2-4', 'shadow mode records match and mismatch without changing returned chain', async () => {
  const writes = [];
  const shadowPromises = [];
  const oldChain = [{ provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 320, temperature: 0.1 }];
  const returned = selectChainWithShadow('hub.alarm.interpreter.error', { team: 'hub' }, {
    mode: 'shadow',
    shadowPromises,
    selectLLMChain: () => oldChain,
    policyEngine: {
      resolvePolicyChain: () => oldChain,
    },
    queryFn: async (_sql, params) => {
      writes.push(params);
      return { rowCount: 1 };
    },
  });
  assert.equal(returned, oldChain);
  await Promise.all(shadowPromises);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2], true);

  const mismatchPromises = [];
  selectChainWithShadow('hub.alarm.interpreter.error', { team: 'hub' }, {
    mode: 'shadow',
    shadowPromises: mismatchPromises,
    selectLLMChain: () => oldChain,
    policyEngine: {
      resolvePolicyChain: () => [{ provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 320, temperature: 0.1 }],
    },
    queryFn: async (_sql, params) => {
      writes.push(params);
      return { rowCount: 1 };
    },
  });
  await Promise.all(mismatchPromises);
  assert.equal(writes[1][2], false);

  const failedWriteReturned = selectChainWithShadow('hub.alarm.interpreter.error', { team: 'hub' }, {
    mode: 'shadow',
    selectLLMChain: () => oldChain,
    policyEngine: { resolvePolicyChain: () => oldChain },
    queryFn: async () => {
      throw new Error('fixture write failure');
    },
  });
  assert.equal(failedWriteReturned, oldChain);

  const defaultDbCalls = [];
  const defaultDbPromises = [];
  selectChainWithShadow('hub.alarm.interpreter.error', { team: 'hub' }, {
    mode: 'shadow',
    shadowPromises: defaultDbPromises,
    selectLLMChain: () => oldChain,
    policyEngine: { resolvePolicyChain: () => oldChain },
    pgPool: {
      query: async (schema, sql, params) => {
        defaultDbCalls.push({ schema, sql, params });
        return { rowCount: 1 };
      },
    },
  });
  await Promise.all(defaultDbPromises);
  assert.equal(defaultDbCalls[0]?.schema, 'public');
  assert.match(defaultDbCalls[0]?.sql || '', /INSERT INTO hub\.llm_policy_shadow_log/);
  return `writes=${writes.length} match=${writes[0][2]} mismatch=${writes[1][2]} schema=${defaultDbCalls[0]?.schema}`;
  });

  await record('TS-R2-5', 'GATE-R pending, ready, and apply-blocked states', async () => {
  const pending = await buildHubLlmPromotionGateReport({
    gate: 'GATE-R',
    queryFn: gateREvidenceQuery({ total: 0, mismatches: 0 }),
  });
  assert.equal(pending.status, 'shadow_ready_data_pending');
  assert.equal(pending.promotionReady, false);

  const ready = await buildHubLlmPromotionGateReport({
    gate: 'GATE-R',
    queryFn: gateREvidenceQuery({ total: 50, mismatches: 0 }),
  });
  assert.equal(ready.status, 'ready_for_master_review');
  assert.equal(ready.ok, true);
  assert.equal(ready.promotionReady, false);

  const blocked = await runHubLlmPromotionGateRuntime({ argv: ['--gate=GATE-R', '--apply', '--json'] });
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.report.status, 'hub_llm_promotion_gate_apply_blocked');
  return `pending=${pending.status} ready=${ready.status} applyExit=${blocked.exitCode}`;
  });

  await record('TS-R2-6', 'agent_registry path emits policy shadow comparison with agent context', async () => {
  const offWrites = [];
  let offEngineCalls = 0;
  const offResult = resolveHubLlmSelection({
    callerTeam: 'darwin',
    agent: 'darwin.planner',
  }, {
    shadowDeps: {
      mode: 'off',
      policyEngine: {
        resolvePolicyChain() {
          offEngineCalls += 1;
          return [];
        },
      },
      queryFn: async () => {
        offWrites.push(true);
        return { rowCount: 1 };
      },
    },
  });
  assert.equal(offResult.source, 'agent_registry');
  assert.equal(offEngineCalls, 0);
  assert.equal(offWrites.length, 0);

  const writes = [];
  const engineContexts = [];
  const shadowPromises = [];
  const result = resolveHubLlmSelection({
    callerTeam: 'darwin',
    agent: 'darwin.planner',
  }, {
    shadowDeps: {
      mode: 'shadow',
      shadowPromises,
      policyEngine: {
        resolvePolicyChain(ctx) {
          engineContexts.push(ctx);
          return resolvePolicyChain(ctx);
        },
      },
      queryFn: async (sql, params) => {
        writes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
  });
  assert.equal(result.source, 'agent_registry');
  await Promise.all(shadowPromises);
  assert.equal(engineContexts.length, 1);
  assert.equal(engineContexts[0].selectorKey, 'darwin.agent_policy');
  assert.equal(engineContexts[0].agent, 'darwin.planner');
  assert.equal(engineContexts[0].agentName, 'darwin.planner');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO hub\.llm_policy_shadow_log/);
  assert.equal(writes[0].params[0], 'darwin.agent_policy');
  assert.equal(writes[0].params[2], true);
  const ctx = JSON.parse(writes[0].params[1]);
  assert.equal(ctx.agent, 'darwin.planner');
  assert.equal(ctx.agentName, 'darwin.planner');
  return `source=${result.source} match=${writes[0].params[2]} agent=${ctx.agent}`;
  });

  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    suite: 'llm-policy-engine-smoke',
    results,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
