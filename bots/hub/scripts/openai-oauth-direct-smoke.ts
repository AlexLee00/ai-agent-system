import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_OAUTH_ACCESS_TOKEN: process.env.OPENAI_OAUTH_ACCESS_TOKEN,
  OPENAI_CODEX_ACCESS_TOKEN: process.env.OPENAI_CODEX_ACCESS_TOKEN,
  OPENAI_OAUTH_PUBLIC_API_TOKEN: process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN,
  OPENAI_CODEX_BACKEND_BASE_URL: process.env.OPENAI_CODEX_BACKEND_BASE_URL,
  USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openai-oauth-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'openai-oauth-direct-token',
          account_id: 'acct_openai_oauth_direct_smoke',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  delete process.env.OPENAI_OAUTH_ACCESS_TOKEN;
  delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
  delete process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN;
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://openai-oauth-direct-smoke.local/backend-api';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; authorization: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const authorization = String(headers?.Authorization || '');
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url, authorization, body });

    assert.equal(url, 'https://openai-oauth-direct-smoke.local/backend-api/codex/responses');
    assert.equal(authorization, 'Bearer openai-oauth-direct-token');
    assert.equal(headers?.['chatgpt-account-id'], 'acct_openai_oauth_direct_smoke');
    assert.equal(headers?.accept, 'text/event-stream');
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'max_output_tokens'), false);
    assert.match(body.instructions, /64 output tokens/);

    return new Response([
      'data: {"type":"response.output_text.delta","delta":"direct oauth "}',
      '',
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_openai_oauth_direct","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const { callOpenAiCodexOAuth } = require('../lib/llm/oauth-direct.ts') as {
      callOpenAiCodexOAuth: (request: Record<string, unknown>) => Promise<any>;
    };
    const { _testOnly: unifiedTestOnly } = require('../lib/llm/unified-caller.ts') as {
      _testOnly: {
        _isInvalidatedOpenAiOAuthError: (error: unknown) => boolean;
        _isRetryableOpenAiOAuthError: (error: unknown) => boolean;
      };
    };
    assert.equal(
      unifiedTestOnly._isInvalidatedOpenAiOAuthError('openai_codex_oauth_call_failed:Encountered invalidated oauth token for user'),
      true,
      'unified caller should classify invalidated OpenAI OAuth tokens for local re-import recovery',
    );
    assert.equal(unifiedTestOnly._isInvalidatedOpenAiOAuthError('openai_codex_oauth_timeout_or_abort'), false);

    const result = await callOpenAiCodexOAuth({
      model: 'gpt-5.4-mini',
      maxTokens: 64,
      temperature: 0.1,
      systemPrompt: 'You are a smoke test.',
      prompt: 'Return a tiny success string.',
      timeoutMs: 5000,
    });

    assert.equal(result.result, 'direct oauth ok');
    assert.equal(result.provider, 'openai-oauth');
    assert.equal(result.model, 'gpt-5.4-mini');
    assert.equal(calls.length, 1);

    globalThis.fetch = (async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as typeof fetch;
    const aborted = await callOpenAiCodexOAuth({
      model: 'gpt-5.4-mini',
      prompt: 'Return a tiny success string.',
      timeoutMs: 1,
    });
    assert.equal(aborted.ok, false);
    assert.match(aborted.error, /openai_codex_oauth_timeout_or_abort/);

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    )) as typeof fetch;
    const badRequest = await callOpenAiCodexOAuth({
      model: 'gpt-5.4-mini',
      prompt: 'Return a tiny success string.',
      maxTokens: 64,
      timeoutMs: 5000,
    });
    assert.equal(badRequest.ok, false);
    assert.match(badRequest.error, /openai_codex_oauth_bad_request:Unsupported parameter: max_output_tokens/);
    assert.equal(badRequest.upstreamStatus, 400);

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: 'temporarily unavailable' } }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '7',
        },
      },
    )) as typeof fetch;
    const unavailable = await callOpenAiCodexOAuth({
      model: 'gpt-5.4-mini',
      prompt: 'Return a tiny success string.',
      timeoutMs: 5000,
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.upstreamStatus, 503);
    assert.equal(unavailable.retryAfterMs, 7_000);

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      model: result.model,
      endpoint: calls[0].url,
      abort_error_normalized: true,
      bad_request_detail_normalized: true,
      upstream_backpressure_preserved: true,
      public_api_used: false,
      invalidated_error_classified: true,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
