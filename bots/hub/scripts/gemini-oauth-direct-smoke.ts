import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  GEMINI_OAUTH_PROJECT_ID: process.env.GEMINI_OAUTH_PROJECT_ID,
  GEMINI_OAUTH_BASE_URL: process.env.GEMINI_OAUTH_BASE_URL,
  USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-oauth-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'gemini-oauth': {
        token: {
          access_token: 'gemini-oauth-direct-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  process.env.GEMINI_OAUTH_PROJECT_ID = 'gemini-oauth-direct-project';
  process.env.GEMINI_OAUTH_BASE_URL = 'https://gemini-oauth-direct.local';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; authorization: string; quotaProject: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({
      url,
      authorization: String(headers?.Authorization || ''),
      quotaProject: String(headers?.['x-goog-user-project'] || ''),
      body,
    });

    assert.equal(url, 'https://gemini-oauth-direct.local/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(headers?.Authorization, 'Bearer gemini-oauth-direct-token');
    assert.equal(headers?.['x-goog-user-project'], 'gemini-oauth-direct-project');
    assert.equal(body.contents[0].parts[0].text, 'Reply with the fixture text.');

    return new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'gemini oauth ok' }],
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { callGeminiOAuth } = await import('../lib/llm/oauth-direct.ts');
    const result = await callGeminiOAuth({
      model: 'gemini-2.5-flash',
      maxTokens: 32,
      temperature: 0,
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply with the fixture text.',
      timeoutMs: 5000,
    });

    assert.equal(result.result, 'gemini oauth ok');
    assert.equal(result.provider, 'gemini-oauth');
    assert.equal(calls.length, 1);

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      model: result.model,
      endpoint: calls[0].url,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[gemini-oauth-direct-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
