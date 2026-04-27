import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalToken = process.env.OPENAI_OAUTH_ACCESS_TOKEN;
const originalPublicToken = process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN;
const originalBaseUrl = process.env.OPENAI_OAUTH_BASE_URL;
const originalMode = process.env.OPENAI_OAUTH_ENDPOINT_MODE;
const originalUseHubSecrets = process.env.USE_HUB_SECRETS;

async function main() {
  delete process.env.OPENAI_OAUTH_ACCESS_TOKEN;
  process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN = 'oauth-public-api-smoke-token';
  process.env.OPENAI_OAUTH_BASE_URL = 'https://openai-oauth-smoke.local/v1';
  process.env.OPENAI_OAUTH_ENDPOINT_MODE = 'responses';
  process.env.USE_HUB_SECRETS = 'false';

  const calls: Array<{ url: string; authorization: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization || '');
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url, authorization, body });

    assert.equal(url, 'https://openai-oauth-smoke.local/v1/responses');
    assert.equal(authorization, 'Bearer oauth-public-api-smoke-token');
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.max_output_tokens, 64);

    return new Response(JSON.stringify({
      id: 'resp_openai_oauth_smoke',
      output_text: 'direct oauth ok',
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const { callWithFallback } = await import('../../../packages/core/lib/llm-fallback.ts');
  const result = await callWithFallback({
    chain: [
      {
        provider: 'openai-oauth',
        model: 'gpt-5.4-mini',
        maxTokens: 64,
        temperature: 0.1,
      },
    ],
    systemPrompt: 'You are a smoke test.',
    userPrompt: 'Return a tiny success string.',
    timeoutMs: 5000,
    logMeta: {
      bot: 'openai-oauth-direct-smoke',
      requestType: 'smoke',
    },
  });

  assert.equal(result.text, 'direct oauth ok');
  assert.equal(result.provider, 'openai-oauth');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(calls.length, 1);

  console.log(JSON.stringify({
    ok: true,
    provider: result.provider,
    model: result.model,
    endpoint: calls[0].url,
    legacy_gateway_used: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENAI_OAUTH_ACCESS_TOKEN;
    else process.env.OPENAI_OAUTH_ACCESS_TOKEN = originalToken;
    if (originalPublicToken === undefined) delete process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN;
    else process.env.OPENAI_OAUTH_PUBLIC_API_TOKEN = originalPublicToken;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_OAUTH_BASE_URL;
    else process.env.OPENAI_OAUTH_BASE_URL = originalBaseUrl;
    if (originalMode === undefined) delete process.env.OPENAI_OAUTH_ENDPOINT_MODE;
    else process.env.OPENAI_OAUTH_ENDPOINT_MODE = originalMode;
    if (originalUseHubSecrets === undefined) delete process.env.USE_HUB_SECRETS;
    else process.env.USE_HUB_SECRETS = originalUseHubSecrets;
  });
