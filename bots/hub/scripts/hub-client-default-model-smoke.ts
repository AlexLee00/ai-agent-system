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
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'timeout clamp smoke', timeoutMs: 600_000 });
    await callHubLlm({
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'blog.pos.writer',
      prompt: 'long blog writer timeout smoke',
      timeoutMs: 600_000,
    });
    await callHubLlm({
      callerTeam: 'luna',
      agent: 'risk',
      selectorKey: 'blog.pos.writer',
      prompt: 'non-blog selector timeout clamp smoke',
      timeoutMs: 600_000,
    });

    assert.equal(capturedBodies[0]?.abstractModel, 'anthropic_haiku', 'missing abstractModel must default to Haiku, not Sonnet');
    assert.equal(capturedBodies[1]?.abstractModel, 'anthropic_haiku', 'unknown abstractModel must downgrade to Haiku');
    assert.equal(capturedBodies[2]?.abstractModel, 'anthropic_sonnet', 'explicit Sonnet request should still be preserved');
    assert.equal(capturedBodies[3]?.timeoutMs, 180_000, 'non-blog LLM calls must stay capped at 180s');
    assert.equal(capturedBodies[4]?.timeoutMs, 600_000, 'blog writer LLM calls must preserve long batch timeout');
    assert.equal(capturedBodies[5]?.timeoutMs, 180_000, 'non-blog calls must not bypass timeout cap with blog writer selector');

    console.log(JSON.stringify({
      ok: true,
      default_abstract_model: capturedBodies[0]?.abstractModel,
      unknown_abstract_model: capturedBodies[1]?.abstractModel,
      explicit_sonnet_preserved: capturedBodies[2]?.abstractModel === 'anthropic_sonnet',
      non_blog_timeout_ms: capturedBodies[3]?.timeoutMs,
      blog_writer_timeout_ms: capturedBodies[4]?.timeoutMs,
      non_blog_blog_selector_timeout_ms: capturedBodies[5]?.timeoutMs,
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
