'use strict';

const assert = require('assert');

const timeout = require('../lib/llm-timeout-profile.ts');
const { resolveSelectorTimeoutProfile } = require('../../../packages/core/lib/selector-timeout-profiles.ts');

function main() {
  const evaluatorProfile = timeout.resolveDarwinLlmTimeoutProfile('evaluator', {});
  assert.strictEqual(evaluatorProfile.selectorKey, 'darwin.agent_policy');
  assert.strictEqual(evaluatorProfile.tier, 'fast');
  assert.strictEqual(evaluatorProfile.source, 'declaration');
  assert.strictEqual(evaluatorProfile.timeoutMs, 25_000);

  const actualSelectorProfile = resolveSelectorTimeoutProfile('darwin.agent_policy', {
    env: { SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true' },
    runtimePurpose: 'proposal_generation',
  });
  assert.strictEqual(actualSelectorProfile.enabled, true);
  assert.strictEqual(actualSelectorProfile.selectorKey, 'darwin.agent_policy');
  assert.strictEqual(actualSelectorProfile.timeoutMs, 120_000);
  assert.strictEqual(resolveSelectorTimeoutProfile('darwin.synthesis', {
    env: { SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true' },
  }).enabled, false);

  assert.strictEqual(timeout.getDarwinTimeoutTier('short'), 25_000);
  assert.strictEqual(timeout.getDarwinTimeoutTier('medium'), 45_000);
  assert.strictEqual(timeout.getDarwinTimeoutTier('long'), 120_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('evaluator'), 25_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('edison_synthesis'), 120_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('implementation'), 45_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('skill_generation'), 45_000);
  assert.strictEqual(timeout.resolveDarwinTimeoutProfileKey('scanner'), 'darwin.agent_policy');
  assert.strictEqual(timeout.resolveDarwinTimeoutProfileKey('success_predicate'), 'darwin.agent_policy');
  assert.strictEqual(timeout.getDarwinLlmTimeout('synthesis', {
    SELECTOR_TIMEOUT_MS_DARWIN_SYNTHESIS: '90000',
  }), 90_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('synthesis', {
    DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS: '90000',
  }), 90_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('synthesis', {
    SELECTOR_TIMEOUT_MS_DARWIN_SYNTHESIS: '1000',
  }), 30_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('synthesis', {
    DARWIN_APPLICATOR_PROPOSAL_TIMEOUT_MS: '999999',
  }), 180_000);
  console.log('✅ darwin llm timeout profile smoke ok');
}

main();
