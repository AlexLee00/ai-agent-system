import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_TS = require.resolve('../lib/oauth/providers/gemini-oauth.ts');
const TOKEN_STORE_TS = require.resolve('../lib/oauth/token-store.ts');
const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  GEMINI_OAUTH_PROJECT_ID: process.env.GEMINI_OAUTH_PROJECT_ID,
  GOOGLE_CLOUD_QUOTA_PROJECT: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GEMINI_OAUTH_BASE_URL: process.env.GEMINI_OAUTH_BASE_URL,
};

function resetModules() {
  delete require.cache[PROVIDER_TS];
  delete require.cache[TOKEN_STORE_TS];
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-oauth-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'gemini-oauth': {
        token: {
          access_token: 'gemini-oauth-smoke-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
        metadata: {
          source: 'smoke_token_store',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  process.env.GEMINI_OAUTH_PROJECT_ID = 'gemini-oauth-smoke-project';
  process.env.GEMINI_OAUTH_BASE_URL = 'https://gemini-oauth-smoke.local';

  const calls: Array<{ url: string; authorization: string; quotaProject: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      authorization: String(headers?.Authorization || ''),
      quotaProject: String(headers?.['x-goog-user-project'] || ''),
    });

    assert.equal(url, 'https://gemini-oauth-smoke.local/v1/models');
    assert.equal(headers?.Authorization, 'Bearer gemini-oauth-smoke-token');
    assert.equal(headers?.['x-goog-user-project'], 'gemini-oauth-smoke-project');
    return new Response(JSON.stringify({
      models: [{ name: 'models/gemini-2.5-flash' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    resetModules();
    const { getGeminiOauthStatus, runGeminiOauthCanary } = require('../lib/oauth/providers/gemini-oauth.ts');
    const status = await getGeminiOauthStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.has_token, true);
    assert.equal(status.expired, false);
    assert.equal(status.quota_project_configured, true);

    const canary = await runGeminiOauthCanary();
    assert.equal(canary.ok, true);
    assert.equal(canary.details.canary_mode, 'gemini_oauth_models_list');
    assert.equal(canary.details.model_count, 1);
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      provider: 'gemini-oauth',
      canary_contract: 'gemini_oauth_models_list_checked',
    }));
  } finally {
    resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[gemini-oauth-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
