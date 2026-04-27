import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  PROJECT_ROOT: process.env.PROJECT_ROOT,
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  GEMINI_CODE_ASSIST_BASE_URL: process.env.GEMINI_CODE_ASSIST_BASE_URL,
  GEMINI_CODE_ASSIST_API_VERSION: process.env.GEMINI_CODE_ASSIST_API_VERSION,
  GEMINI_CODE_ASSIST_PRO_PROJECT_ID: process.env.GEMINI_CODE_ASSIST_PRO_PROJECT_ID,
  USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
};
const originalFetch = globalThis.fetch;

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-codeassist-oauth-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'gemini-codeassist-oauth': {
        token: {
          access_token: 'gemini-codeassist-oauth-direct-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.PROJECT_ROOT = tempRoot;
  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  process.env.GEMINI_CODE_ASSIST_BASE_URL = 'https://gemini-codeassist-direct.local';
  process.env.GEMINI_CODE_ASSIST_API_VERSION = 'v1internal';
  process.env.GEMINI_CODE_ASSIST_PRO_PROJECT_ID = 'gemini-codeassist-direct-project';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; authorization: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({
      url,
      authorization: String(headers?.Authorization || ''),
      body,
    });

    assert.equal(url, 'https://gemini-codeassist-direct.local/v1internal:generateContent');
    assert.equal(headers?.Authorization, 'Bearer gemini-codeassist-oauth-direct-token');
    assert.equal(body.model, 'gemini-2.5-pro');
    assert.equal(body.project, 'gemini-codeassist-direct-project');
    assert.equal(body.request.contents[0].parts[0].text, 'Reply with the fixture text.');

    return new Response(JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: 'gemini codeassist oauth ok' }],
            },
          },
        ],
      },
      traceId: 'fixture-trace',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { callGeminiCodeAssistOAuth } = await import('../lib/llm/oauth-direct.ts');
    const result = await callGeminiCodeAssistOAuth({
      model: 'gemini-codeassist-oauth/gemini-2.5-pro',
      maxTokens: 32,
      temperature: 0,
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply with the fixture text.',
      timeoutMs: 5000,
    });

    assert.equal(result.result, 'gemini codeassist oauth ok');
    assert.equal(result.provider, 'gemini-codeassist-oauth');
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
    console.error('[gemini-codeassist-oauth-direct-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
