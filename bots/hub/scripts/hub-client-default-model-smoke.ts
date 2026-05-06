#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

async function main() {
  const originalEnv = {
    HUB_BASE_URL: process.env.HUB_BASE_URL,
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN,
  };
  const originalFetch = global.fetch;

  const capturedBodies = [];
  process.env.HUB_BASE_URL = 'http://hub-client-default-model-smoke.local';
  process.env.HUB_AUTH_TOKEN = 'hub-client-default-model-smoke-token';

  global.fetch = async (_input, init = {}) => {
    capturedBodies.push(JSON.parse(String(init.body || '{}')));
    return new Response(JSON.stringify({
      ok: true,
      text: 'ok',
      provider: 'openai-oauth',
      selected_route: 'openai-oauth/gpt-5.4-mini',
      durationMs: 1,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const hubClientPath = path.join(PROJECT_ROOT, 'packages/core/lib/hub-client');
    delete require.cache[require.resolve(hubClientPath)];
    const { callHubLlm } = require(hubClientPath);

    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'default model smoke' });
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'unknown model smoke', abstractModel: 'unexpected-model' });
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'explicit sonnet smoke', abstractModel: 'claude-code/sonnet' });

    assert.equal(capturedBodies[0]?.abstractModel, 'anthropic_haiku', 'missing abstractModel must default to Haiku, not Sonnet');
    assert.equal(capturedBodies[1]?.abstractModel, 'anthropic_haiku', 'unknown abstractModel must downgrade to Haiku');
    assert.equal(capturedBodies[2]?.abstractModel, 'anthropic_sonnet', 'explicit Sonnet request should still be preserved');

    console.log(JSON.stringify({
      ok: true,
      default_abstract_model: capturedBodies[0]?.abstractModel,
      unknown_abstract_model: capturedBodies[1]?.abstractModel,
      explicit_sonnet_preserved: capturedBodies[2]?.abstractModel === 'anthropic_sonnet',
    }));
  } finally {
    global.fetch = originalFetch;
    if (originalEnv.HUB_BASE_URL == null) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = originalEnv.HUB_BASE_URL;
    if (originalEnv.HUB_AUTH_TOKEN == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalEnv.HUB_AUTH_TOKEN;
  }
}

main().catch((error) => {
  console.error('[hub-client-default-model-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
