#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const policyEngine = require('../../../packages/core/lib/llm-policy-engine.ts');
const { getAgentDefinition } = require('../../../packages/core/lib/agent-yaml-loader.ts');
const hubSelector = require('../src/llm-selector.ts');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEAM_DIR = path.join(PROJECT_ROOT, 'bots', 'investment', 'team');

const REQUIRED_INVESTMENT_AGENTS = [
  'adaptive-risk',
  'argos',
  'aria',
  'athena',
  'budget',
  'chronos',
  'hanul',
  'hephaestos',
  'hermes',
  'kairos',
  'luna',
  'nemesis',
  'oracle',
  'reporter',
  'scout',
  'sentinel',
  'sophia',
  'stock-flow',
  'sweeper',
  'zeus',
].sort();

const REQUIRED_RULE_BASED_AGENTS = [
  'aria',
  'budget',
  'hanul',
  'hephaestos',
].sort();

type AgentModelTarget = {
  agent: string;
  selectorKey?: string;
};

function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (backup[key] == null) delete process.env[key];
      else process.env[key] = backup[key];
    }
  }
}

function stableChain(chain: any[]): string {
  return JSON.stringify(chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: entry.maxTokens ?? null,
    temperature: entry.temperature ?? null,
    timeoutMs: entry.timeoutMs ?? null,
  })));
}

function stableRoute(chain: any[]): string {
  return JSON.stringify(chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: entry.maxTokens ?? null,
    temperature: entry.temperature ?? null,
  })));
}

function assertRuleBasedRoutingDisabled(yamlRoutingEnabled: string): void {
  const selectorOptions = {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: `investment-rule-based-${yamlRoutingEnabled}`,
  };
  const hostilePolicyOverride = {
    enabled: true,
    primary: { provider: 'openai-oauth', model: 'gpt-5.4' },
    fallbacks: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
    fallbackChain: [
      { provider: 'openai-oauth', model: 'gpt-5.4' },
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
    ],
  };

  for (const agentName of REQUIRED_RULE_BASED_AGENTS) {
    const selectorKey = `investment.${agentName}`;
    const directChain = selector.selectLLMChain(selectorKey, selectorOptions);
    const delegatedChain = selector.selectLLMChain('investment.agent_policy', {
      ...selectorOptions,
      agentName,
    });
    assert.deepEqual(
      directChain,
      [],
      `${selectorKey} must remain LLM-disabled when LUNA_YAML_ROUTING_ENABLED=${yamlRoutingEnabled}`,
    );
    assert.deepEqual(
      delegatedChain,
      [],
      `investment.agent_policy/${agentName} must remain LLM-disabled when LUNA_YAML_ROUTING_ENABLED=${yamlRoutingEnabled}`,
    );
    assert.deepEqual(
      selector.selectLLMChain(selectorKey, { ...selectorOptions, policyOverride: hostilePolicyOverride }),
      [],
      `${selectorKey} must reject a hostile policyOverride`,
    );
    assert.deepEqual(
      selector.selectLLMChain('investment.agent_policy', {
        ...selectorOptions,
        agentName,
        policyOverride: hostilePolicyOverride,
      }),
      [],
      `investment.agent_policy/${agentName} must reject a hostile policyOverride`,
    );

    assert.deepEqual(
      policyEngine.resolvePolicyChain({
        selectorKey: 'investment.agent_policy',
        team: 'investment',
        callerTeam: 'investment',
        agentName,
        agent: agentName,
      }),
      [],
      `investment.agent_policy/${agentName} policy engine must preserve the LLM 0 contract`,
    );
    assert.deepEqual(
      policyEngine.resolvePolicyChain({
        selectorKey: 'investment.agent_policy',
        team: 'investment',
        callerTeam: 'investment',
        agentName: agentName.toUpperCase(),
      }),
      [],
      `investment.agent_policy/${agentName} policy engine must normalize agent casing`,
    );

    const hubSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: agentName,
      selectorKey,
      selectorVersion: selectorOptions.selectorVersion,
      rolloutPercent: selectorOptions.rolloutPercent,
      rolloutKey: selectorOptions.rolloutKey,
      policyOverride: hostilePolicyOverride,
    });
    assert.deepEqual(hubSelection.chain, [], `${selectorKey} Hub path must preserve the LLM 0 contract`);

    const agentOnlyHubSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: agentName,
      selectorVersion: selectorOptions.selectorVersion,
      rolloutPercent: selectorOptions.rolloutPercent,
      rolloutKey: `${selectorOptions.rolloutKey}:agent-only`,
      policyOverride: hostilePolicyOverride,
    });
    assert.deepEqual(agentOnlyHubSelection.chain, [], `investment/${agentName} agent-only Hub path must preserve the LLM 0 contract`);
    assert.equal(agentOnlyHubSelection.nonLlm, true, `investment/${agentName} agent-only Hub path must be terminal non-LLM`);

    const hostileSelectorHubSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: agentName,
      selectorKey: 'hub._default',
    });
    assert.deepEqual(hostileSelectorHubSelection.chain, [], `investment/${agentName} must reject a hostile selectorKey`);
    assert.equal(hostileSelectorHubSelection.nonLlm, true, `investment/${agentName} hostile selectorKey path must remain terminal non-LLM`);

    const hostileAdhocHubSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: agentName,
      chain: [{ provider: 'openai-oauth', model: 'gpt-5.4' }],
    }, { allowAdhocChain: true });
    assert.deepEqual(hostileAdhocHubSelection.chain, [], `investment/${agentName} must reject an allowed ad-hoc chain`);
    assert.equal(hostileAdhocHubSelection.nonLlm, true, `investment/${agentName} ad-hoc path must remain terminal non-LLM`);

    const mixedCaseAgent = agentName.toUpperCase();
    const mixedCaseAgentOnlySelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: mixedCaseAgent,
    });
    assert.deepEqual(mixedCaseAgentOnlySelection.chain, [], `investment/${mixedCaseAgent} agent-only path must remain terminal non-LLM`);
    assert.equal(mixedCaseAgentOnlySelection.nonLlm, true, `investment/${mixedCaseAgent} agent-only path must normalize casing`);

    const mixedCaseHostileSelectorSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: mixedCaseAgent,
      selectorKey: 'hub._default',
    });
    assert.deepEqual(mixedCaseHostileSelectorSelection.chain, [], `investment/${mixedCaseAgent} must reject a hostile selectorKey`);
    assert.equal(mixedCaseHostileSelectorSelection.nonLlm, true, `investment/${mixedCaseAgent} hostile selector path must normalize casing`);

    const mixedCaseHostileAdhocSelection = hubSelector.resolveHubLlmSelection({
      callerTeam: 'investment',
      agent: mixedCaseAgent,
      chain: [{ provider: 'openai-oauth', model: 'gpt-5.4' }],
    }, { allowAdhocChain: true });
    assert.deepEqual(mixedCaseHostileAdhocSelection.chain, [], `investment/${mixedCaseAgent} must reject an allowed ad-hoc chain`);
    assert.equal(mixedCaseHostileAdhocSelection.nonLlm, true, `investment/${mixedCaseAgent} ad-hoc path must normalize casing`);

    for (const alias of ['agentName', 'runtimeAgent']) {
      const aliasSelection = hubSelector.resolveHubLlmSelection({
        callerTeam: 'investment',
        [alias]: mixedCaseAgent,
        selectorKey: 'hub._default',
      });
      assert.deepEqual(aliasSelection.chain, [], `investment/${mixedCaseAgent} ${alias} path must reject a hostile selectorKey`);
      assert.equal(aliasSelection.nonLlm, true, `investment/${mixedCaseAgent} ${alias} path must remain terminal non-LLM`);
    }
  }
}

function main(): void {
  const yamlAgents = readdirSync(TEAM_DIR)
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => file.replace(/\.yaml$/, ''))
    .sort();

  assert.deepEqual(yamlAgents, REQUIRED_INVESTMENT_AGENTS, 'investment YAML agents must match explicit selector coverage');

  const selectorKeys = new Set(selector.listLLMSelectorKeys());
  assert(selectorKeys.has('investment._default'), 'investment._default selector key must exist');

  const selectorOptions = {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: 'investment-explicit-selector-smoke',
  };

  const defaultChain = selector.selectLLMChain('investment._default', selectorOptions);
  const delegatedDefault = selector.selectLLMChain('investment.agent_policy', {
    ...selectorOptions,
    agentName: 'default',
  });
  assert.equal(stableChain(defaultChain), stableChain(delegatedDefault), 'investment._default must match delegated default policy');

  const targets = selector.listAgentModelTargets('investment') as AgentModelTarget[];
  const targetMap = new Map(targets.map((entry: AgentModelTarget) => [entry.agent, entry]));
  const ruleBasedAgents: string[] = [];

  for (const agentName of REQUIRED_INVESTMENT_AGENTS) {
    const selectorKey = `investment.${agentName}`;
    assert(selectorKeys.has(selectorKey), `${selectorKey} selector key must exist`);

    const directChain = selector.selectLLMChain(selectorKey, selectorOptions);
    const policyChain = policyEngine.resolvePolicyChain({
      selectorKey,
      team: 'investment',
      callerTeam: 'investment',
      agentName,
      agent: agentName,
    });
    const delegatedChain = selector.selectLLMChain('investment.agent_policy', {
      ...selectorOptions,
      agentName,
    });
    const definition = getAgentDefinition(agentName, { teamDir: TEAM_DIR });
    const isRuleBased = definition?.llm_routing?.primary === 'rule-based';
    if (isRuleBased) ruleBasedAgents.push(agentName);

    assert.equal(
      directChain.length > 0,
      !isRuleBased,
      `${selectorKey} chain presence must follow its YAML routing policy`,
    );
    assert.equal(
      stableRoute(directChain),
      stableRoute(delegatedChain),
      `${selectorKey} must preserve the existing investment.agent_policy route`,
    );
    assert.equal(
      stableChain(directChain),
      stableChain(policyChain),
      `${selectorKey} policy-engine route must match the active selector`,
    );
    if (!isRuleBased) {
      assert.notEqual(directChain[0]?.provider, 'anthropic', `${selectorKey} primary must not use the retired anthropic provider`);
    }

    const target = targetMap.get(agentName);
    assert.equal(target?.selectorKey, selectorKey, `describeAgentModel investment/${agentName} must expose the explicit selector key`);
    const description = selector.describeAgentModel('investment', agentName, { [selectorKey]: selectorOptions });
    assert.equal(description.selected, !isRuleBased, `investment/${agentName} selection must follow its YAML routing policy`);
    assert.equal(description.selectorKey, selectorKey, `investment/${agentName} selectorKey must stay explicit`);
    if (isRuleBased) {
      assert.equal(description.description?.enabled, false, `investment/${agentName} must keep LLM routing disabled`);
    }
  }

  assert.deepEqual(
    ruleBasedAgents.sort(),
    REQUIRED_RULE_BASED_AGENTS,
    'rule-based investment agents must match the reviewed allowlist',
  );

  console.log(JSON.stringify({
    ok: true,
    explicit_selector_keys: REQUIRED_INVESTMENT_AGENTS.length + 1,
    yaml_agents: yamlAgents.length,
    rule_based_agents: ruleBasedAgents,
    default_key: 'investment._default',
  }, null, 2));
}

try {
  withEnv({
    LUNA_YAML_ROUTING_ENABLED: 'true',
    SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
  }, () => {
    main();
    assertRuleBasedRoutingDisabled('true');
  });
  withEnv({
    LUNA_YAML_ROUTING_ENABLED: 'false',
    SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
  }, () => assertRuleBasedRoutingDisabled('false'));
} catch (error: any) {
  console.error('[investment-selector-explicit-keys-smoke] failed:', error?.message || error);
  process.exit(1);
}
