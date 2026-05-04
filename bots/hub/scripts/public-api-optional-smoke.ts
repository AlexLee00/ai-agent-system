#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fakeOpenAi = 'not-a-real-openai-public-api-smoke-value';
const fakeAnthropic = 'not-a-real-anthropic-public-api-smoke-value';
const fakeGemini = 'not-a-real-gemini-public-api-smoke-value';
const envSnapshot = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
}

function setDisabledPublicApiEnv() {
  process.env.OPENAI_API_KEY = fakeOpenAi;
  process.env.ANTHROPIC_API_KEY = fakeAnthropic;
  process.env.GEMINI_API_KEY = fakeGemini;
  process.env.SIGMA_SECRETS_PATH = path.join(repoRoot, '.missing-sigma-secrets-for-public-api-smoke.json');
  for (const key of [
    'HUB_ENABLE_OPENAI_PUBLIC_API',
    'HUB_ENABLE_CLAUDE_PUBLIC_API',
    'HUB_ENABLE_ANTHROPIC_PUBLIC_API',
    'HUB_ENABLE_GEMINI_PUBLIC_API',
    'HUB_ENABLE_GOOGLE_PUBLIC_API',
  ]) delete process.env[key];
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function main() {
  try {
    setDisabledPublicApiEnv();

    const llmKeys = require('../../../packages/core/lib/llm-keys.ts');
    assert.equal(llmKeys.publicProviderEnabled('openai'), false);
    assert.equal(llmKeys.publicProviderEnabled('anthropic'), false);
    assert.equal(llmKeys.publicProviderEnabled('gemini'), false);
    assert.equal(llmKeys.getOpenAIKey(), null, 'OpenAI public API key must be ignored unless explicitly enabled');
    assert.equal(llmKeys.getAnthropicKey(), null, 'Anthropic public API key must be ignored unless explicitly enabled');
    assert.equal(llmKeys.getGeminiKey(), null, 'Gemini public API key must be ignored unless explicitly enabled');

    const testerSupport = require('../../../packages/core/lib/llm-control/tester-support.ts');
    assert.equal(testerSupport.loadProviderKey(fs, 'openai'), null, 'speed-test OpenAI key must be ignored unless public API is enabled');

    const sigmaSecrets = require('../../sigma/shared/secrets.ts');
    assert.equal(sigmaSecrets.loadSecrets().anthropic_api_key, '', 'Sigma Anthropic public key must be ignored unless explicitly enabled');

    assert.equal(
      fs.existsSync(path.join(repoRoot, 'bots/hub/lib/oauth/providers/openai-public-api.ts')),
      true,
      'OpenAI public API provider must live in a tracked non-secret-looking file',
    );
    const oauthRoutes = read('bots/hub/lib/oauth/routes.ts');
    assert.match(oauthRoutes, /providers\/openai-public-api/, 'OAuth routes must import the tracked OpenAI public provider');
    assert.doesNotMatch(oauthRoutes, /providers\/openai-api-key/, 'OAuth routes must not import ignored api-key provider path');

    const openAiPublicProvider = require('../lib/oauth/providers/openai-public-api.ts');
    const status = await openAiPublicProvider.getOpenAiApiKeyStatus();
    assert.equal(status.enabled, false, 'OpenAI public API provider must default to disabled');
    assert.equal(status.has_api_key, false, 'OpenAI public API provider must ignore keys while disabled');

    const gatedSources = [
      'bots/ska/src/forecast.py',
      'bots/ska/lib/rag_client.py',
      'bots/darwin/elixir/lib/darwin/v2/config.ex',
      'bots/darwin/elixir/lib/darwin/v2/skill/vlm_feedback.ex',
      'bots/sigma/elixir/lib/sigma/v2/llm/policy.ex',
      'bots/investment/elixir/lib/luna/v2/llm/policy.ex',
    ];
    for (const source of gatedSources) {
      const text = read(source);
      assert.match(
        text,
        /HUB_ENABLE_(OPENAI|CLAUDE|ANTHROPIC|GEMINI|GOOGLE)_PUBLIC_API/,
        `${source} must gate public API key usage behind HUB_ENABLE_*_PUBLIC_API`,
      );
    }

    console.log(JSON.stringify({
      ok: true,
      public_api_default_disabled: true,
      tracked_openai_public_provider: true,
      gated_sources: gatedSources.length,
    }));
  } finally {
    resetEnv();
  }
}

main().catch((error) => {
  console.error('[public-api-optional-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
