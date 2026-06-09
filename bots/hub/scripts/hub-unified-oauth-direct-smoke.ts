#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_CODEX_BACKEND_BASE_URL: process.env.OPENAI_CODEX_BACKEND_BASE_URL,
  HUB_BUDGET_GUARDIAN_ENABLED: process.env.HUB_BUDGET_GUARDIAN_ENABLED,
  HUB_LLM_PROVIDER_CIRCUIT_ENABLED: process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED,
  HUB_LLM_ALLOW_ADHOC_CHAIN: process.env.HUB_LLM_ALLOW_ADHOC_CHAIN,
  HUB_LLM_GEMINI_DISABLED: process.env.HUB_LLM_GEMINI_DISABLED,
  HUB_OPENAI_OAUTH_RETRY_ATTEMPTS: process.env.HUB_OPENAI_OAUTH_RETRY_ATTEMPTS,
  HUB_OPENAI_OAUTH_RETRY_DELAY_MS: process.env.HUB_OPENAI_OAUTH_RETRY_DELAY_MS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const unifiedCallerSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts'), 'utf8');
  assert.equal(
    unifiedCallerSource.includes('packages/core/lib/llm-fallback'),
    false,
    'Hub unified caller must not route OAuth providers through the core fallback engine',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unified-oauth-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'hub-unified-openai-token',
          account_id: 'acct_hub_unified_smoke',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://hub-unified-openai.local/backend-api';
  process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';
  process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED = 'false';
  process.env.HUB_LLM_ALLOW_ADHOC_CHAIN = '1';

  const calls: Array<{ provider: string; url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body || '{}'));

    if (url.includes('/codex/responses')) {
      calls.push({ provider: 'openai-oauth', url });
      assert.equal(url, 'https://hub-unified-openai.local/backend-api/codex/responses');
      assert.equal(headers?.Authorization, 'Bearer hub-unified-openai-token');
      assert.equal(headers?.['chatgpt-account-id'], 'acct_hub_unified_smoke');
      assert.equal(headers?.originator, 'pi');
      assert.equal(headers?.accept, 'text/event-stream');
      assert.equal(body.model, 'gpt-5.4-mini');
      assert.equal(body.stream, true);

      return new Response([
        'data: {"type":"response.output_text.delta","delta":"openai direct "}',
        '',
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_hub_unified","status":"completed","usage":{"input_tokens":2,"output_tokens":3}}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    throw new Error(`unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  const successfulOpenAiFetch = globalThis.fetch;

  try {
    const unifiedCaller = require('../lib/llm/unified-caller.ts') as {
      callWithFallback: (request: Record<string, unknown>) => Promise<any>;
      _testOnly: {
        _shouldSuppressFallbackExhaustionAlarm: (request: Record<string, unknown>, error: unknown) => boolean;
      };
    };
    const { callWithFallback } = unifiedCaller;
    const sender = await import('../../../packages/core/lib/telegram-sender.ts');

    const openAiResult = await callWithFallback({
      callerTeam: 'blog',
      agent: 'gems',
      selectorKey: 'hub.unified.oauth.openai.smoke',
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply exactly OK.',
      timeoutMs: 5000,
    });
    assert.equal(openAiResult.ok, true);
    assert.equal(openAiResult.provider, 'openai-oauth');
    assert.equal(openAiResult.result, 'openai direct ok');

    assert.deepEqual(calls.map((call) => call.provider), ['openai-oauth']);

    process.env.HUB_OPENAI_OAUTH_RETRY_ATTEMPTS = '1';
    process.env.HUB_OPENAI_OAUTH_RETRY_DELAY_MS = '0';
    let transientOpenAiCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/codex/responses')) {
          transientOpenAiCalls += 1;
          if (transientOpenAiCalls === 1) {
            throw new DOMException('This operation was aborted', 'AbortError');
          }
        }
        return successfulOpenAiFetch(input, init);
      }) as typeof fetch;

      const retryRecovered = await callWithFallback({
        callerTeam: 'hub',
        agent: 'unified-oauth-openai-retry-smoke',
        chain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }],
        prompt: 'This path should recover from one transient OpenAI OAuth abort.',
        timeoutMs: 5000,
        cacheEnabled: false,
        suppressFallbackExhaustionAlarm: true,
      });
      assert.equal(retryRecovered.ok, true);
      assert.equal(retryRecovered.provider, 'openai-oauth');
      assert.equal(retryRecovered.fallbackCount, 0, 'OpenAI OAuth retry must preserve primary route success');
      assert.equal(retryRecovered.retryCount, 1, 'one transient abort should be retried once');
      assert.equal(transientOpenAiCalls, 2);
    } finally {
      globalThis.fetch = successfulOpenAiFetch;
    }

    let noRetryOpenAiCalls = 0;
    try {
      globalThis.fetch = (async () => {
        noRetryOpenAiCalls += 1;
        throw new DOMException('This operation was aborted', 'AbortError');
      }) as typeof fetch;

      const noRetryFailure = await callWithFallback({
        callerTeam: 'hub',
        agent: 'unified-oauth-openai-no-retry-smoke',
        chain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini', retryAttempts: 0 }],
        prompt: 'This path should not retry inside the OpenAI OAuth route.',
        timeoutMs: 5000,
        cacheEnabled: false,
        suppressFallbackExhaustionAlarm: true,
      });
      assert.equal(noRetryFailure.ok, false);
      assert.match(noRetryFailure.error, /fallback_exhausted/);
      assert.equal(noRetryOpenAiCalls, 1, 'route-level retryAttempts=0 should skip OpenAI OAuth retry');
    } finally {
      globalThis.fetch = successfulOpenAiFetch;
    }

    process.env.HUB_LLM_GEMINI_DISABLED = 'true';
    const geminiDisabledFallback = await callWithFallback({
      callerTeam: 'hub',
      agent: 'oauth-monitor',
      chain: [
        { provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash' },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
      ],
      prompt: 'Gemini is disabled; use OpenAI.',
      timeoutMs: 5000,
      cacheEnabled: false,
    });
    assert.equal(geminiDisabledFallback.ok, true);
    assert.equal(geminiDisabledFallback.provider, 'openai-oauth');
    assert.equal(geminiDisabledFallback.selected_route, 'openai-oauth/gpt-5.4-mini');
    assert.equal(geminiDisabledFallback.fallbackCount, 0, 'disabled Gemini route should be removed before execution');
    assert.deepEqual(calls.map((call) => call.provider), ['openai-oauth', 'openai-oauth', 'openai-oauth']);
    delete process.env.HUB_LLM_GEMINI_DISABLED;

    assert.equal(
      unifiedCaller._testOnly._shouldSuppressFallbackExhaustionAlarm(
        { selectorKey: 'hub.unified.oauth.openai.smoke' },
        null,
      ),
      true,
      'Hub smoke selectors must suppress production fallback exhaustion alarms',
    );
    assert.equal(
      unifiedCaller._testOnly._shouldSuppressFallbackExhaustionAlarm(
        { selectorKey: 'hub.alarm.interpreter.work' },
        null,
      ),
      true,
      'Hub alarm interpreter enrichment must fail open without emitting fallback exhaustion criticals',
    );
    assert.equal(
      unifiedCaller._testOnly._shouldSuppressFallbackExhaustionAlarm(
        { selectorKey: 'hub.alarm.classifier' },
        null,
      ),
      true,
      'Hub alarm classifier enrichment must fail open without emitting fallback exhaustion criticals',
    );
    assert.equal(
      unifiedCaller._testOnly._shouldSuppressFallbackExhaustionAlarm(
        { selectorKey: 'blog.pos.writer', taskType: 'smoke_test_name_must_not_suppress' },
        null,
      ),
      false,
      'production selectors must not suppress fallback exhaustion based on taskType alone',
    );

    let criticalCalls = 0;
    const originalSendCritical = sender.default?.sendCritical || sender.sendCritical;
    const patchedSendCritical = async () => {
      criticalCalls += 1;
      return true;
    };
    if (sender.default?.sendCritical) sender.default.sendCritical = patchedSendCritical;
    if (sender.sendCritical) sender.sendCritical = patchedSendCritical;
    try {
      globalThis.fetch = (async () => {
        throw new DOMException('This operation was aborted', 'AbortError');
      }) as typeof fetch;
      const autoSuppressed = await callWithFallback({
        callerTeam: 'hub',
        agent: 'unified-oauth-openai-smoke',
        selectorKey: 'hub.unified.oauth.openai.smoke',
        systemPrompt: 'You are a smoke test.',
        prompt: 'This smoke path intentionally fails.',
        timeoutMs: 5000,
        cacheEnabled: false,
      });
      assert.equal(autoSuppressed.ok, false);
      assert.match(autoSuppressed.error, /fallback_exhausted/);
      assert.equal(criticalCalls, 0, 'smoke selectors must not emit fallback exhaustion criticals');

      const suppressed = await callWithFallback({
        callerTeam: 'hub',
        agent: 'oauth-monitor',
        chain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }],
        prompt: 'This path intentionally fails.',
        timeoutMs: 5000,
        cacheEnabled: false,
        suppressFallbackExhaustionAlarm: true,
      });
      assert.equal(suppressed.ok, false);
      assert.match(suppressed.error, /fallback_exhausted/);
      assert.equal(criticalCalls, 0, 'explicitly suppressed probe must not emit fallback exhaustion critical');
    } finally {
      if (sender.default?.sendCritical) sender.default.sendCritical = originalSendCritical;
      if (sender.sendCritical) sender.sendCritical = originalSendCritical;
    }

    console.log(JSON.stringify({
      ok: true,
      providers: calls.map((call) => call.provider),
      gemini_oauth_retired: true,
      gemini_disabled_fallback: true,
      openai_oauth_transient_retry: true,
      fallback_exhaustion_suppressed: true,
      core_fallback_used: false,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[hub-unified-oauth-direct-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
