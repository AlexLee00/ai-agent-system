import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  GPT_OSS_20B_MODEL,
  GROQ_SCOUT_MODEL,
  HAIKU_MODEL,
  OPENAI_MINI_MODEL,
  OPENAI_PERF_MODEL,
} from '../shared/llm-client.ts';
import { getInvestmentLLMPolicyConfig } from '../shared/runtime-config.ts';

const require = createRequire(import.meta.url);
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.ts');

function assertNoLegacyOpenAiMiniModel(model: unknown, label: string) {
  const normalized = String(model || '').trim().toLowerCase();
  assert.notEqual(normalized, 'gpt-4o-mini', `${label} must not use stale gpt-4o-mini`);
  assert.notEqual(normalized, 'openai-oauth/gpt-4o-mini', `${label} must not use stale openai-oauth/gpt-4o-mini`);
}

function main() {
  const policy = getInvestmentLLMPolicyConfig()?.investmentAgentPolicy || {};
  assertNoLegacyOpenAiMiniModel(policy.openaiMiniModel, 'runtime_config.llmPolicies.investmentAgentPolicy.openaiMiniModel');
  for (const [label, model] of Object.entries({
    GPT_OSS_20B_MODEL,
    GROQ_SCOUT_MODEL,
    HAIKU_MODEL,
    OPENAI_MINI_MODEL,
    OPENAI_PERF_MODEL,
  })) {
    assert.equal(typeof model, 'string', `${label} must be a string`);
    assert(model.trim().length > 0, `${label} must not be empty`);
  }
  assertNoLegacyOpenAiMiniModel(OPENAI_MINI_MODEL, 'llm-client OPENAI_MINI_MODEL');

  for (const selectorKey of ['investment.athena', 'investment.nemesis', 'investment.agent_policy', 'investment._default']) {
    const chain = selectLLMChain(selectorKey, {
      agentName: selectorKey.split('.').pop(),
      maxTokens: 128,
    });
    assert(Array.isArray(chain) && chain.length > 0, `${selectorKey} must resolve to a non-empty selector chain`);
    for (const entry of chain) {
      if (entry.provider !== 'openai-oauth') continue;
      assertNoLegacyOpenAiMiniModel(entry.model, `${selectorKey} openai-oauth route`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    llm_client_models: {
      GPT_OSS_20B_MODEL,
      GROQ_SCOUT_MODEL,
      HAIKU_MODEL,
      OPENAI_MINI_MODEL,
      OPENAI_PERF_MODEL,
    },
    runtime_openai_mini_model: policy.openaiMiniModel,
    checked_selectors: ['investment.athena', 'investment.nemesis', 'investment.agent_policy', 'investment._default'],
  }));
}

try {
  main();
} catch (error) {
  console.error('investment-llm-openai-model-policy-smoke failed:', error);
  process.exit(1);
}
