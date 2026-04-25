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
  OPENAI_OAUTH_ENDPOINT_MODE: process.env.OPENAI_OAUTH_ENDPOINT_MODE,
};

function resetModules() {
  delete require.cache[PROVIDER_TS];
  delete require.cache[TOKEN_STORE_TS];
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openai-codex-backend-canary-'));
  const storeFile = path.join(tempDir, 'token-store.json');
  fs.writeFileSync(storeFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'chatgpt-backend-smoke-token',
          account_id: 'acct_codex_smoke',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        metadata: {
          source: 'smoke_token_store',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.HUB_OAUTH_STORE_FILE = storeFile;
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://chatgpt-backend-smoke.local/backend-api';
  delete process.env.OPENAI_CODEX_OAUTH_CANARY_MODE;
  delete process.env.OPENAI_OAUTH_ENDPOINT_MODE;

  const calls: Array<{ url: string; authorization: string; accountId: string; userAgent: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      authorization: String(headers?.Authorization || ''),
      accountId: String(headers?.['ChatGPT-Account-Id'] || ''),
      userAgent: String(headers?.['User-Agent'] || ''),
    });

    assert.equal(url, 'https://chatgpt-backend-smoke.local/backend-api/wham/usage');
    assert.equal(headers?.Authorization, 'Bearer chatgpt-backend-smoke-token');
    assert.equal(headers?.['ChatGPT-Account-Id'], 'acct_codex_smoke');
    assert.equal(headers?.['User-Agent'], 'CodexBar');

    return new Response(JSON.stringify({
      planType: 'pro',
      rate_limit: {
        used: 1,
        limit: 100,
      },
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
    assert.equal(result.details.canary_mode, 'chatgpt_backend');
    assert.equal(result.details.endpoint, 'wham/usage');
    assert.equal(result.details.status, 200);
    assert.equal(result.details.account_id_present, true);
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      canary_contract: 'chatgpt_backend_usage_checked',
    }));
  } finally {
    resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[openai-codex-chatgpt-backend-canary-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
