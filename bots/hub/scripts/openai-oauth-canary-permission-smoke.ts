import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_TS = require.resolve('../lib/oauth/providers/openai-codex-oauth.ts');
const TOKEN_STORE_TS = require.resolve('../lib/oauth/token-store.ts');
const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
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
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        metadata: {
          source: 'smoke_token_store',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.HUB_OAUTH_STORE_FILE = storeFile;
  process.env.OPENAI_OAUTH_BASE_URL = 'https://openai-canary-smoke.local/v1';
  process.env.OPENAI_OAUTH_ENDPOINT_MODE = 'responses';

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(url, 'https://openai-canary-smoke.local/v1/responses');
    assert.equal(String((init?.headers as Record<string, string> | undefined)?.Authorization || ''), 'Bearer canary-permission-smoke-token');
    return new Response(JSON.stringify({
      error: {
        message: 'Missing scopes: api.responses.write',
      },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    resetModules();
    const { runOpenAiCodexOauthCanary } = require('../lib/oauth/providers/openai-codex-oauth.ts');
    const result = await runOpenAiCodexOauthCanary();

    assert.equal(result.ok, false);
    assert.equal(result.error, 'api_canary_failed');
    assert.equal(result.details.status, 401);
    assert.equal(result.details.endpoint, 'responses');
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      canary_contract: 'api_permission_checked',
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
