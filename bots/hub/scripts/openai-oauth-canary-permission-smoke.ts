import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_TS = require.resolve('../lib/oauth/providers/openai-codex-oauth.ts');
const TOKEN_STORE_TS = require.resolve('../lib/oauth/token-store.ts');
const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_CODEX_OAUTH_CANARY_MODE: process.env.OPENAI_CODEX_OAUTH_CANARY_MODE,
  OPENAI_CODEX_BACKEND_BASE_URL: process.env.OPENAI_CODEX_BACKEND_BASE_URL,
  OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API: process.env.OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API,
  OPENAI_OAUTH_PUBLIC_API_TOKEN: process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN,
  OPENAI_OAUTH_BASE_URL: process.env.OPENAI_OAUTH_BASE_URL,
  OPENAI_OAUTH_ENDPOINT_MODE: process.env.OPENAI_OAUTH_ENDPOINT_MODE,
};

function resetModules() {
  delete require.cache[PROVIDER_TS];
  delete require.cache[TOKEN_STORE_TS];
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openai-canary-'));
  const storeFile = path.join(tempDir, 'token-store.json');
  fs.writeFileSync(storeFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'canary-permission-smoke-token',
          account_id: 'acct_canary_permission_smoke',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        metadata: {
          source: 'smoke_token_store',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.HUB_OAUTH_STORE_FILE = storeFile;
  process.env.OPENAI_CODEX_OAUTH_CANARY_MODE = 'public_api';
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://chatgpt-backend-canary-fallback.local/backend-api';
  delete process.env.OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API;
  delete process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN;
  process.env.OPENAI_OAUTH_BASE_URL = 'https://openai-canary-smoke.local/v1';
  process.env.OPENAI_OAUTH_ENDPOINT_MODE = 'responses';

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const headers = init?.headers as Record<string, string> | undefined;

    if (url === 'https://openai-canary-smoke.local/v1/responses') {
      assert.equal(String(headers?.Authorization || ''), 'Bearer public-api-smoke-token');
      return new Response(JSON.stringify({
        error: {
          message: 'Missing scopes: api.responses.write',
        },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    assert.equal(url, 'https://chatgpt-backend-canary-fallback.local/backend-api/wham/usage');
    assert.equal(String(headers?.Authorization || ''), 'Bearer canary-permission-smoke-token');
    assert.equal(headers?.['ChatGPT-Account-Id'], 'acct_canary_permission_smoke');
    return new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: { used: 1, limit: 100 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    resetModules();
    const { runOpenAiCodexOauthCanary } = require('../lib/oauth/providers/openai-codex-oauth.ts');
    const result = await runOpenAiCodexOauthCanary();

    assert.equal(result.ok, true);
    assert.equal(Boolean(result.degraded), false);
    assert.equal(result.details.canary_mode, 'chatgpt_backend_fallback');
    assert.equal(result.details.status, 200);
    assert.equal(result.details.public_api.ok, false);
    assert.equal(result.details.public_api.skipped, true);
    assert.equal(result.details.public_api.error, 'public_api_token_missing');
    assert.equal(result.details.public_api.details.endpoint, 'responses');
    assert.equal(result.details.public_api.details.enabled, false);
    assert.deepEqual(calls, [
      'https://chatgpt-backend-canary-fallback.local/backend-api/wham/usage',
    ]);

    process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN = 'public-api-smoke-token';
    resetModules();
    calls.length = 0;
    const { runOpenAiCodexOauthCanary: runFallbackCanary } = require('../lib/oauth/providers/openai-codex-oauth.ts');
    const fallbackResult = await runFallbackCanary();
    assert.equal(fallbackResult.ok, true);
    assert.equal(fallbackResult.degraded, true);
    assert.equal(fallbackResult.details.public_api.error, 'api_canary_failed');
    assert.equal(fallbackResult.details.public_api.details.status, 401);
    assert.equal(fallbackResult.details.public_api.details.endpoint, 'responses');
    assert.equal(fallbackResult.details.public_api.details.permission_issue.required_scope, 'api.responses.write');
    assert.deepEqual(calls, [
      'https://openai-canary-smoke.local/v1/responses',
      'https://chatgpt-backend-canary-fallback.local/backend-api/wham/usage',
    ]);

    process.env.OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API = '1';
    resetModules();
    calls.length = 0;
    const { runOpenAiCodexOauthCanary: runStrictCanary } = require('../lib/oauth/providers/openai-codex-oauth.ts');
    const strictResult = await runStrictCanary();
    assert.equal(strictResult.ok, false);
    assert.equal(strictResult.error, 'api_canary_failed');
    assert.equal(strictResult.details.permission_issue.required_scope, 'api.responses.write');
    assert.deepEqual(calls, ['https://openai-canary-smoke.local/v1/responses']);

    console.log(JSON.stringify({
      ok: true,
      canary_contract: 'public_api_token_optional_backend_checked',
    }));
  } finally {
    resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[openai-oauth-canary-permission-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
