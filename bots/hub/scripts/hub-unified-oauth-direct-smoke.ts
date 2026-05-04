#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv: Record<string, string | undefined> = {
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  OPENAI_CODEX_BACKEND_BASE_URL: process.env.OPENAI_CODEX_BACKEND_BASE_URL,
  GEMINI_OAUTH_BASE_URL: process.env.GEMINI_OAUTH_BASE_URL,
  GEMINI_OAUTH_PROJECT_ID: process.env.GEMINI_OAUTH_PROJECT_ID,
  GOOGLE_CLOUD_QUOTA_PROJECT: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  HUB_BUDGET_GUARDIAN_ENABLED: process.env.HUB_BUDGET_GUARDIAN_ENABLED,
  HUB_LLM_PROVIDER_CIRCUIT_ENABLED: process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED,
};
const originalFetch = globalThis.fetch;

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const unifiedCallerSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts'), 'utf8');
  assert.equal(
    unifiedCallerSource.includes('packages/core/lib/llm-fallback'),
    false,
    'Hub unified caller must not route OAuth providers through the core fallback engine',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unified-oauth-direct-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  fs.writeFileSync(tokenStoreFile, `${JSON.stringify({
    providers: {
      'openai-codex-oauth': {
        token: {
          access_token: 'hub-unified-openai-token',
          account_id: 'acct_hub_unified_smoke',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
      },
      'gemini-oauth': {
        token: {
          access_token: 'hub-unified-gemini-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
        metadata: {
          project_id: 'hub-unified-gemini-project',
        },
      },
    },
  })}\n`, 'utf8');

  process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
  process.env.OPENAI_CODEX_BACKEND_BASE_URL = 'https://hub-unified-openai.local/backend-api';
  process.env.GEMINI_OAUTH_BASE_URL = 'https://hub-unified-gemini.local';
  delete process.env.GEMINI_OAUTH_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';
  process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED = 'false';

  const calls: Array<{ provider: string; url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body || '{}'));

    if (url.includes('/codex/responses')) {
      calls.push({ provider: 'openai-oauth', url });
      assert.equal(url, 'https://hub-unified-openai.local/backend-api/codex/responses');
      assert.equal(headers?.Authorization, 'Bearer hub-unified-openai-token');
      assert.equal(headers?.['chatgpt-account-id'], 'acct_hub_unified_smoke');
      assert.equal(headers?.originator, 'pi');
      assert.equal(headers?.accept, 'text/event-stream');
      assert.equal(body.model, 'gpt-5.4-mini');
      assert.equal(body.stream, true);

      return new Response([
        'data: {"type":"response.output_text.delta","delta":"openai direct "}',
        '',
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_hub_unified","status":"completed","usage":{"input_tokens":2,"output_tokens":3}}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (url.includes(':generateContent')) {
      calls.push({ provider: 'gemini-oauth', url });
      assert.equal(url, 'https://hub-unified-gemini.local/v1beta/models/gemini-2.5-flash:generateContent');
      assert.equal(headers?.Authorization, 'Bearer hub-unified-gemini-token');
      assert.equal(headers?.['x-goog-user-project'], 'hub-unified-gemini-project');
      assert.equal(body.contents[0].parts[0].text, 'Reply exactly OK.');

      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'gemini direct ok' }] } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const { callWithFallback } = await import('../lib/llm/unified-caller.ts');

    const openAiResult = await callWithFallback({
      callerTeam: 'blog',
      agent: 'gems',
      selectorKey: 'hub.unified.oauth.openai.smoke',
      chain: [{ provider: 'openai', model: 'gpt-5.4-mini', maxTokens: 32, temperature: 0 }],
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply exactly OK.',
      timeoutMs: 5000,
    });
    assert.equal(openAiResult.ok, true);
    assert.equal(openAiResult.provider, 'openai-oauth');
    assert.equal(openAiResult.result, 'openai direct ok');

    const geminiResult = await callWithFallback({
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'hub.unified.oauth.gemini.smoke',
      chain: [{ provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 32, temperature: 0 }],
      systemPrompt: 'You are a smoke test.',
      prompt: 'Reply exactly OK.',
      timeoutMs: 5000,
    });
    assert.equal(geminiResult.ok, true);
    assert.equal(geminiResult.provider, 'gemini-oauth');
    assert.equal(geminiResult.result, 'gemini direct ok');
    assert.deepEqual(calls.map((call) => call.provider), ['openai-oauth', 'gemini-oauth']);

    console.log(JSON.stringify({
      ok: true,
      providers: calls.map((call) => call.provider),
      core_fallback_used: false,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error('[hub-unified-oauth-direct-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
