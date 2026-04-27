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
    const { callOpenAiCodexOAuth } = await import('../lib/llm/oauth-direct.ts');
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

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      model: result.model,
      endpoint: calls[0].url,
      public_api_used: false,
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
