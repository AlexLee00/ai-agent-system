import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_OAUTH_ACCESS_TOKEN: process.env.OPENAI_OAUTH_ACCESS_TOKEN,
  OPENAI_CODEX_ACCESS_TOKEN: process.env.OPENAI_CODEX_ACCESS_TOKEN,
  OPENAI_OAUTH_BASE_URL: process.env.OPENAI_OAUTH_BASE_URL,
  OPENAI_OAUTH_ENDPOINT_MODE: process.env.OPENAI_OAUTH_ENDPOINT_MODE,
  USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openai-oauth-store-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'token-store-smoke-token',
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
  process.env.OPENAI_OAUTH_BASE_URL = 'https://openai-token-store-smoke.local/v1';
  process.env.OPENAI_OAUTH_ENDPOINT_MODE = 'responses';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; authorization: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization || '');
    calls.push({ url, authorization });

    assert.equal(url, 'https://openai-token-store-smoke.local/v1/responses');
    assert.equal(authorization, 'Bearer token-store-smoke-token');

    return new Response(JSON.stringify({
      id: 'resp_openai_oauth_token_store_smoke',
      output_text: 'token store oauth ok',
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { callWithFallback } = await import('../../../packages/core/lib/llm-fallback.ts');
    const result = await callWithFallback({
      chain: [
        {
          provider: 'openai-oauth',
          model: 'gpt-5.4-mini',
          maxTokens: 32,
          temperature: 0,
        },
      ],
      systemPrompt: 'You are a smoke test.',
      userPrompt: 'Reply with the fixture text.',
      timeoutMs: 5000,
      logMeta: {
        bot: 'openai-oauth-token-store-smoke',
        requestType: 'smoke',
      },
    });

    assert.equal(result.text, 'token store oauth ok');
    assert.equal(result.provider, 'openai-oauth');
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      token_source: 'hub_oauth_token_store',
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[openai-oauth-token-store-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
