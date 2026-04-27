import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_OAUTH_ACCESS_TOKEN: process.env.OPENAI_OAUTH_ACCESS_TOKEN,
  OPENAI_CODEX_ACCESS_TOKEN: process.env.OPENAI_CODEX_ACCESS_TOKEN,
  OPENAI_OAUTH_ENDPOINT_MODE: process.env.OPENAI_OAUTH_ENDPOINT_MODE,
  OPENAI_CODEX_BACKEND_BASE_URL: process.env.OPENAI_CODEX_BACKEND_BASE_URL,
  USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openai-codex-backend-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'codex-backend-direct-token',
          account_id: 'acct_codex_direct_smoke',
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
  delete process.env.OPENAI_OAUTH_ENDPOINT_MODE;
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://chatgpt-backend-direct-smoke.local/backend-api';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url, headers: headers || {}, body });

    assert.equal(url, 'https://chatgpt-backend-direct-smoke.local/backend-api/codex/responses');
    assert.equal(headers?.Authorization, 'Bearer codex-backend-direct-token');
    assert.equal(headers?.['chatgpt-account-id'], 'acct_codex_direct_smoke');
    assert.equal(headers?.originator, 'pi');
    assert.equal(headers?.['OpenAI-Beta'], 'responses=experimental');
    assert.equal(headers?.accept, 'text/event-stream');
    assert.equal(body.model, 'gpt-5.4');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);

    return new Response([
      'data: {"type":"response.output_text.delta","delta":"codex backend "}',
      '',
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      '',
      'data: {"type":"response.output_text.done","text":"codex backend ok"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_codex_backend_direct","status":"completed","usage":{"input_tokens":4,"output_tokens":3}}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const { callOpenAiCodexOAuth } = await import('../lib/llm/oauth-direct.ts');
    const result = await callOpenAiCodexOAuth({
      model: 'gpt-5.4',
      maxTokens: 32,
      temperature: 0,
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply with the fixture text.',
      timeoutMs: 5000,
    });

    assert.equal(result.result, 'codex backend ok');
    assert.equal(result.provider, 'openai-oauth');
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      endpoint: calls[0].url,
      legacy_gateway_used: false,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[openai-codex-backend-direct-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
