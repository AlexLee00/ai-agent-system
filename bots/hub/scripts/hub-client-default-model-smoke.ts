#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

async function main() {
  const originalEnv = {
    HUB_BASE_URL: process.env.HUB_BASE_URL,
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN,
    HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES: process.env.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES,
  };
  const originalFetch = global.fetch;
  const originalExecFileSync = childProcess.execFileSync;
  const curlCalls = [];

  const capturedBodies = [];
  process.env.HUB_BASE_URL = 'http://127.0.0.1:7788';
  process.env.HUB_AUTH_TOKEN = 'hub-client-default-model-smoke-token';
  process.env.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES = '32768';

  childProcess.execFileSync = (command, args, options) => {
    if (command !== '/usr/bin/curl') return originalExecFileSync(command, args, options);
    curlCalls.push({ command, args });
    const url = String(args?.[args.length - 1] || '');
    if (url.includes('/hub/llm/selector')) {
      return `${JSON.stringify({
        ok: false,
        error: { code: 'provider_cooldown', message: 'selector provider cooling down' },
      })}\n__HUB_CURL_META__503\t5`;
    }
    const dataIndex = args?.indexOf('--data') ?? -1;
    const curlPayload = dataIndex >= 0 ? JSON.parse(String(args?.[dataIndex + 1] || '{}')) : {};
    if (curlPayload.prompt === 'curl status only smoke') {
      return `${JSON.stringify({})}\n__HUB_CURL_META__503\t9`;
    }
    return `${JSON.stringify({
      ok: false,
      error: { code: 'queue_timeout', message: 'curl transport admission timeout' },
    })}\n__HUB_CURL_META__503\t7`;
  };

  global.fetch = async (input, init = {}) => {
    const requestBody = JSON.parse(String(init.body || '{}'));
    capturedBodies.push(requestBody);
    if (String(input).includes('/hub/llm/selector')) {
      const error = new Error('fetch failed');
      error.cause = new Error('connect EPERM 127.0.0.1:7788');
      throw error;
    }
    if (requestBody.prompt === 'curl backpressure smoke' || requestBody.prompt === 'curl status only smoke') {
      const error = new Error('fetch failed');
      error.cause = new Error('connect EPERM 127.0.0.1:7788');
      throw error;
    }
    if (String(input).endsWith('/hub/llm/embeddings')) {
      return new Response(JSON.stringify({
        ok: true,
        model: 'qwen3-embed-0.6b',
        dimensions: 2,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestBody.prompt === 'backpressure smoke') {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'queue_timeout', message: 'LLM admission queue wait timeout' },
        retryAfterMs: 1_800,
      }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '2' },
      });
    }
    if (requestBody.prompt === 'provider backpressure smoke') {
      return new Response(JSON.stringify({
        ok: false,
        error: 'fallback_exhausted: Groq 429',
        providerBackpressure: {
          kind: 'provider_rate_limit',
          retryAfterMs: 60_000,
          httpStatus: 429,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestBody.prompt === 'cycle budget smoke') {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'cycle_budget_exceeded', message: 'cycle budget exhausted' },
        retryAfterMs: 60_000,
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestBody.prompt === 'job enqueue smoke') {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'job_enqueue_failed', message: 'async job queue unavailable' },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      text: 'ok',
      provider: 'openai-oauth',
      selected_route: 'openai-oauth/gpt-5.4-mini',
      durationMs: 1,
      limiterReleaseWarning: true,
      limiterReleaseUncertain: true,
      releaseError: 'shared_limiter_release_timeout',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const hubClientPath = path.join(PROJECT_ROOT, 'packages/core/lib/hub-client');
    delete require.cache[require.resolve(hubClientPath)];
    const { callHubEmbedding, callHubLlm, fetchHubLlmSelector, isHubNoDirectFallbackFailure } = require(hubClientPath);

    const firstResult = await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'default model smoke' });
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'unknown model smoke', abstractModel: 'unexpected-model' });
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'explicit sonnet smoke', abstractModel: 'claude-code/sonnet' });
    await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'timeout clamp smoke', timeoutMs: 600_000 });
    await callHubLlm({
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'blog.pos.writer',
      prompt: 'long blog writer timeout smoke',
    });
    await callHubLlm({
      callerTeam: 'luna',
      agent: 'risk',
      selectorKey: 'blog.pos.writer',
      prompt: 'non-blog selector timeout clamp smoke',
      timeoutMs: 600_000,
    });
    await callHubLlm({
      callerTeam: 'smoke',
      agent: 'default',
      prompt: 'x'.repeat(120_000),
      systemPrompt: 's'.repeat(40_000),
      timeoutMs: 10_000,
    });
    await callHubEmbedding({ callerTeam: 'smoke', agent: 'embedding', input: 'hello' });
    await callHubLlm({
      callerTeam: 'darwin',
      agent: 'synthesis',
      prompt: 'runtime purpose alias smoke',
      runtimePurpose: 'research_synthesis',
    });
    let backpressureError;
    try {
      await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'backpressure smoke' });
    } catch (error) {
      backpressureError = error;
    }
    const centralFailures = [];
    for (const prompt of ['provider backpressure smoke', 'cycle budget smoke', 'job enqueue smoke']) {
      try {
        await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt });
      } catch (error) {
        centralFailures.push(error);
      }
    }
    let curlBackpressureError;
    try {
      await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'curl backpressure smoke' });
    } catch (error) {
      curlBackpressureError = error;
    }
    let curlSelectorError;
    try {
      await fetchHubLlmSelector({
        selectorKey: 'blog.pos.writer',
        callerTeam: 'blog',
        agent: 'pos',
      });
    } catch (error) {
      curlSelectorError = error;
    }
    let curlStatusOnlyError;
    try {
      await callHubLlm({ callerTeam: 'smoke', agent: 'default', prompt: 'curl status only smoke' });
    } catch (error) {
      curlStatusOnlyError = error;
    }

    assert.equal(capturedBodies[0]?.abstractModel, 'anthropic_haiku', 'missing abstractModel must default to Haiku, not Sonnet');
    assert.equal(capturedBodies[0]?.timeoutMs, 180_000, 'default client envelope must not abort before the Hub runtime timeout');
    assert.equal(firstResult.limiterReleaseWarning, true, 'shared Hub clients must preserve limiter release warnings');
    assert.equal(firstResult.releaseError, 'shared_limiter_release_timeout');
    assert.equal(capturedBodies[1]?.abstractModel, 'anthropic_haiku', 'unknown abstractModel must downgrade to Haiku');
    assert.equal(capturedBodies[2]?.abstractModel, 'anthropic_sonnet', 'explicit Sonnet request should still be preserved');
    assert.equal(capturedBodies[3]?.timeoutMs, 180_000, 'non-blog LLM calls must stay capped at 180s');
    assert.equal(capturedBodies[4]?.timeoutMs, 600_000, 'blog writer LLM calls must preserve long batch timeout');
    assert.equal(capturedBodies[5]?.timeoutMs, 180_000, 'non-blog calls must not bypass timeout cap with blog writer selector');
    assert.equal(capturedBodies[6]?.payloadTrimmed, true, 'oversized Hub LLM payload should be trimmed client-side');
    assert.ok(
      Buffer.byteLength(JSON.stringify(capturedBodies[6]), 'utf8') <= 32768,
      'trimmed Hub LLM payload should stay below client payload cap',
    );
    assert.equal(capturedBodies[7]?.timeoutMs, 180_000, 'embedding client envelope must match the Hub default timeout');
    assert.equal(capturedBodies[8]?.taskType, 'research_synthesis', 'runtime purpose must drive the normalized Hub task type');
    assert.equal(backpressureError?.httpStatus, 503, 'Hub client must preserve the HTTP status');
    assert.equal(backpressureError?.retryAfterMs, 1_800, 'body retryAfterMs must take precedence over the header');
    assert.equal(backpressureError?.limiterBackpressure, true, 'admission 503 must remain identifiable as backpressure');
    assert.equal(backpressureError?.code, 'queue_timeout', 'structured Hub error code must be preserved');
    assert.equal(centralFailures.length, 3, 'all central policy failures must reject the client call');
    assert.equal(centralFailures[0]?.code, 'provider_rate_limit', 'nested provider backpressure kind must be preserved');
    assert.equal(centralFailures[0]?.providerBackpressure, true, 'provider backpressure must be classified separately');
    assert.equal(centralFailures[0]?.retryAfterMs, 60_000, 'nested provider retry metadata must be preserved');
    assert.equal(centralFailures[1]?.code, 'cycle_budget_exceeded', 'cycle budget code must be preserved');
    assert.equal(centralFailures[2]?.code, 'job_enqueue_failed', 'job enqueue code must be preserved');
    for (const failure of centralFailures) {
      assert.equal(failure?.noDirectFallback, true, 'central Hub policy failures must prohibit direct fallback');
      assert.equal(isHubNoDirectFallbackFailure(failure), true, 'shared classifier must expose the no-direct-fallback contract');
    }
    assert.equal(curlBackpressureError?.httpStatus, 503, 'curl fallback must preserve Hub HTTP status');
    assert.equal(curlBackpressureError?.retryAfterMs, 7_000, 'curl fallback must preserve Retry-After');
    assert.equal(curlBackpressureError?.code, 'queue_timeout');
    assert.equal(curlBackpressureError?.limiterBackpressure, true);
    assert.equal(curlSelectorError?.httpStatus, 503, 'GET curl fallback must preserve Hub HTTP status');
    assert.equal(curlSelectorError?.retryAfterMs, 5_000, 'GET curl fallback must preserve Retry-After');
    assert.equal(curlSelectorError?.code, 'provider_cooldown');
    assert.equal(curlStatusOnlyError?.httpStatus, 503, 'curl must not treat an empty 503 body as success');
    assert.equal(curlStatusOnlyError?.retryAfterMs, 9_000);
    assert.equal(curlCalls.length, 3, 'curl fallback must run only for the three restricted fetch calls');

    console.log(JSON.stringify({
      ok: true,
      default_abstract_model: capturedBodies[0]?.abstractModel,
      unknown_abstract_model: capturedBodies[1]?.abstractModel,
      explicit_sonnet_preserved: capturedBodies[2]?.abstractModel === 'anthropic_sonnet',
      non_blog_timeout_ms: capturedBodies[3]?.timeoutMs,
      blog_writer_timeout_ms: capturedBodies[4]?.timeoutMs,
      non_blog_blog_selector_timeout_ms: capturedBodies[5]?.timeoutMs,
      payload_trimmed: capturedBodies[6]?.payloadTrimmed === true,
      embedding_timeout_ms: capturedBodies[7]?.timeoutMs,
      runtime_purpose_task_type: capturedBodies[8]?.taskType,
    }));
  } finally {
    global.fetch = originalFetch;
    childProcess.execFileSync = originalExecFileSync;
    if (originalEnv.HUB_BASE_URL == null) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = originalEnv.HUB_BASE_URL;
    if (originalEnv.HUB_AUTH_TOKEN == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalEnv.HUB_AUTH_TOKEN;
    if (originalEnv.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES == null) delete process.env.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES;
    else process.env.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES = originalEnv.HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES;
  }
}

main().catch((error) => {
  console.error('[hub-client-default-model-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
