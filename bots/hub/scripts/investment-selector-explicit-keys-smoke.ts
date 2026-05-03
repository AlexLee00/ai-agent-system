#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

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
  'scout',
  'sentinel',
  'sophia',
  'stock-flow',
  'sweeper',
  'zeus',
].sort();

function stableChain(chain: any[]): string {
  return JSON.stringify(chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: entry.maxTokens ?? null,
    temperature: entry.temperature ?? null,
    timeoutMs: entry.timeoutMs ?? null,
  })));
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

  const targets = selector.listAgentModelTargets('investment');
  const targetMap = new Map(targets.map((entry) => [entry.agent, entry]));

  for (const agentName of REQUIRED_INVESTMENT_AGENTS) {
    const selectorKey = `investment.${agentName}`;
    assert(selectorKeys.has(selectorKey), `${selectorKey} selector key must exist`);

    const directChain = selector.selectLLMChain(selectorKey, selectorOptions);
    const delegatedChain = selector.selectLLMChain('investment.agent_policy', {
      ...selectorOptions,
      agentName,
    });
    assert(directChain.length > 0, `${selectorKey} chain must be non-empty`);
    assert.equal(
      stableChain(directChain),
      stableChain(delegatedChain),
      `${selectorKey} must preserve the existing investment.agent_policy route`,
    );
    assert.notEqual(directChain[0]?.provider, 'anthropic', `${selectorKey} primary must not use the retired anthropic provider`);

    const target = targetMap.get(agentName);
    assert.equal(target?.selectorKey, selectorKey, `describeAgentModel investment/${agentName} must expose the explicit selector key`);
    const description = selector.describeAgentModel('investment', agentName, { [selectorKey]: selectorOptions });
    assert.equal(description.selected, true, `investment/${agentName} must resolve through describeAgentModel`);
    assert.equal(description.selectorKey, selectorKey, `investment/${agentName} selectorKey must stay explicit`);
  }

  console.log(JSON.stringify({
    ok: true,
    explicit_selector_keys: REQUIRED_INVESTMENT_AGENTS.length + 1,
    yaml_agents: yamlAgents.length,
    default_key: 'investment._default',
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[investment-selector-explicit-keys-smoke] failed:', error?.message || error);
  process.exit(1);
}
