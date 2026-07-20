#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildHubLlmCallPayload } from '../shared/hub-llm-client.ts';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.js');
const {
  buildAgentYamlRoutingPolicy,
  isLunaYamlRoutingEnabled,
  listInvestmentYamlRoutingPolicies,
} = require('../../../packages/core/lib/agent-llm-routing-adapter.js');

const RULE_BASED = new Set(['aria', 'budget', 'hanul', 'hephaestos']);
const TASK_GATED_YAML = new Set(['chronos']);

function withEnv(value, work) {
  const previous = process.env.LUNA_YAML_ROUTING_ENABLED;
  try {
    if (value == null) delete process.env.LUNA_YAML_ROUTING_ENABLED;
    else process.env.LUNA_YAML_ROUTING_ENABLED = value;
    return work();
  } finally {
    if (previous == null) delete process.env.LUNA_YAML_ROUTING_ENABLED;
    else process.env.LUNA_YAML_ROUTING_ENABLED = previous;
  }
}

function compactChain(chain = []) {
  return (chain || []).map((entry) => ({
    provider: entry.provider,
    model: entry.model,
  }));
}

function hasGemini(chain = []) {
  return (chain || []).some((entry) => String(entry.provider || '').toLowerCase().includes('gemini'));
}

export function runLunaYamlRoutingSmoke() {
  const policies = listInvestmentYamlRoutingPolicies();
  assert.equal(policies.length, 20, '20 Luna agent YAML files must be visible to core adapter');
  assert.ok(policies.every((item) => item.validation?.ok === true), 'all YAML definitions validate');

  const malformed = buildAgentYamlRoutingPolicy({
    name: 'broken',
    llm_routing: { primary: 'groq', fallbacks: [] },
  });
  assert.equal(malformed, null, 'malformed provider/model label must fail open');

  const offChains = withEnv('false', () => Object.fromEntries(
    policies.map((item) => [
      item.agentName,
      compactChain(selector.selectLLMChain(`investment.${item.agentName}`, {
        agentName: item.agentName,
        selectorVersion: 'v3.0_oauth_4',
        rolloutPercent: 100,
      })),
    ]),
  ));
  assert.ok(offChains.luna.length > 0, 'env OFF must preserve existing selector chain');
  const offDescription = withEnv('false', () => selector.describeLLMSelector('investment.luna', {
    agentName: 'luna',
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
  }));
  assert.equal(isLunaYamlRoutingEnabled({ LUNA_YAML_ROUTING_ENABLED: 'false' }), false, 'explicit false must be the reverse switch');
  assert.equal(offDescription.routingSource, 'oauth4', 'explicit false must preserve oauth4 routing source');

  const unsetDescription = withEnv(null, () => selector.describeLLMSelector('investment.luna', {
    agentName: 'luna',
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
  }));
  assert.equal(isLunaYamlRoutingEnabled({}), true, 'unset env must default to YAML routing');
  assert.equal(isLunaYamlRoutingEnabled({ LUNA_YAML_ROUTING_ENABLED: 'true' }), true, 'explicit true must enable YAML routing');
  assert.equal(unsetDescription.routingSource, 'yaml', 'unset env must expose yaml routing source');

  const yamlChecks = withEnv('true', () => policies.map((item) => {
    const policy = item.policy;
    assert.ok(policy, `${item.agentName} must have adapter policy`);
    const chain = selector.selectLLMChain(`investment.${item.agentName}`, {
      agentName: item.agentName,
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
    });
    const described = selector.describeLLMSelector(`investment.${item.agentName}`, {
      agentName: item.agentName,
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
    });
    if (TASK_GATED_YAML.has(item.agentName)) {
      assert.equal(described.routingSource, 'oauth4', `${item.agentName} plain route must remain oauth4`);
      const embeddingChain = selector.selectLLMChain(`investment.${item.agentName}`, {
        agentName: item.agentName,
        taskType: 'backtest_embedding',
        selectorVersion: 'v3.0_oauth_4',
        rolloutPercent: 100,
      });
      const embeddingDescription = selector.describeLLMSelector(`investment.${item.agentName}`, {
        agentName: item.agentName,
        taskType: 'backtest_embedding',
        selectorVersion: 'v3.0_oauth_4',
        rolloutPercent: 100,
      });
      assert.equal(embeddingDescription.routingSource, 'yaml', `${item.agentName} embedding route must use yaml`);
      assert.deepEqual(compactChain(embeddingChain), compactChain(policy.fallbackChain));
      return {
        agentName: item.agentName,
        disabled: false,
        taskGated: true,
        chain: compactChain(embeddingChain),
      };
    }
    assert.equal(described.routingSource, 'yaml', `${item.agentName} describe output must expose yaml routing source`);
    assert.equal(described.enabled === false, RULE_BASED.has(item.agentName));
    if (RULE_BASED.has(item.agentName)) {
      assert.equal(chain.length, 0, `${item.agentName} must remain LLM disabled`);
      return { agentName: item.agentName, disabled: true, chain: [] };
    }
    assert.deepEqual(compactChain(chain), compactChain(policy.fallbackChain), `${item.agentName} chain must match YAML`);
    assert.equal(hasGemini(chain), false, `${item.agentName} YAML route must not contain Gemini`);
    return { agentName: item.agentName, disabled: false, chain: compactChain(chain) };
  }));

  const defaultPayload = withEnv(null, () => buildHubLlmCallPayload('luna', 'system', 'reply ok', {
    market: 'binance',
    taskType: 'final_decision',
    maxTokens: 64,
  }));
  assert.equal(defaultPayload._routingSource, 'yaml', 'unset env must label Luna payload as yaml');

  const payload = withEnv('true', () => buildHubLlmCallPayload('luna', 'system', 'reply ok', {
    market: 'binance',
    taskType: 'final_decision',
    maxTokens: 64,
  }));
  assert.equal(payload._routingSource, 'yaml');
  assert.equal(JSON.stringify(payload).includes('_routingSource'), false, 'routing source must stay local-only');

  return {
    ok: true,
    totalAgents: policies.length,
    ruleBasedAgents: Array.from(RULE_BASED).sort(),
    defaultRoutingSource: unsetDescription.routingSource,
    reverseSwitchRoutingSource: offDescription.routingSource,
    yamlChecks,
    offLunaPrimary: offChains.luna[0],
    malformedFallback: malformed === null,
  };
}

async function main() {
  const result = runLunaYamlRoutingSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-yaml-routing-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-yaml-routing-smoke failed:' });
}
