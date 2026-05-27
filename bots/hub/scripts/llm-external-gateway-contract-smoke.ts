#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { resolveHubLlmSelection } = require('../src/llm-selector');
const {
  buildExternalGatewayReadiness,
} = require('../lib/stage-c/resilience');

async function withServer(app: any, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function main(): Promise<void> {
  const readiness = buildExternalGatewayReadiness();
  assert.equal(readiness.ok, true, 'external LLM gateway readiness must pass');
  assert.equal(readiness.standardRoute, '/hub/llm/gateway-contract');

  const selected = resolveHubLlmSelection({
    callerTeam: 'external-blog',
    agent: 'writer',
    selectorKey: 'blog.pos.writer',
    taskType: 'external_blog_post',
    requestId: 'external-gateway-contract-smoke',
    maxBudgetUsd: 0.05,
  });
  assert.equal(selected.ok, true, `external selectorKey route must resolve: ${selected.error || 'unknown'}`);
  assert.equal(selected.selectorKey, 'blog.pos.writer');
  assert(Array.isArray(selected.providerTiers) && selected.providerTiers.length > 0, 'provider tiers are required for external observability');

  const blocked = resolveHubLlmSelection({
    callerTeam: 'blog',
    agent: 'publ',
    taskType: 'external_publish_attempt',
  });
  assert.equal(blocked.ok, false, 'non-LLM target must remain blocked for external callers');
  assert.equal(blocked.error, 'llm_non_llm_target_blocked');

  const originalToken = process.env.HUB_AUTH_TOKEN;
  process.env.HUB_AUTH_TOKEN = 'external-gateway-contract-smoke-token';
  try {
    const { createHubApp } = require('../src/app');
    const app = createHubApp({
      isShuttingDown: () => false,
      isStartupComplete: () => true,
    });
    await withServer(app, async (baseUrl) => {
      const missingAuth = await fetch(`${baseUrl}/hub/llm/gateway-contract`);
      assert.equal(missingAuth.status, 401, 'gateway contract must require Hub bearer auth');

      const response = await fetch(`${baseUrl}/hub/llm/gateway-contract`, {
        headers: {
          Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
          'X-Hub-Team': 'external-smoke',
          'X-Hub-Agent': 'contract-checker',
        },
      });
      const body = await response.json();
      assert.equal(response.status, 200, 'gateway contract endpoint must respond');
      assert.equal(body.ok, true);
      assert.equal(body.contractVersion, 'hub-llm-gateway/v1');
      assert.equal(body.endpoints.syncCall.path, '/hub/llm/call');
      assert.equal(body.endpoints.vision.path, '/hub/llm/vision');
      assert.equal(body.endpoints.embeddings.path, '/hub/llm/embeddings');
      assert.equal(body.selectorPolicy.directProviderRoutes, 'disabled_by_default');
      assert.equal(body.providerPolicy.geminiDisableFlag, 'HUB_LLM_GEMINI_DISABLED');
      assert.equal(typeof body.providerPolicy.geminiDisabled, 'boolean');

      const invalidVision = await fetch(`${baseUrl}/hub/llm/vision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Hub-Team': 'external-smoke',
          'X-Hub-Agent': 'contract-checker',
        },
        body: JSON.stringify({
          callerTeam: 'blog',
          agent: 'blo',
          selectorKey: 'blog._default',
          prompt: 'invalid image smoke',
          imageBase64: 'not-valid-base64!!',
        }),
      });
      const invalidVisionBody = await invalidVision.json();
      assert.equal(invalidVision.status, 400, 'vision endpoint must reject malformed base64 before provider calls');
      assert.equal(invalidVisionBody.error, 'invalid_image_base64');
    });
  } finally {
    if (originalToken == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalToken;
  }

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_c',
    gateway_contract_route: readiness.standardRoute,
    external_selector_key: selected.selectorKey,
    provider_tiers: selected.providerTiers,
    non_llm_guard: blocked.error,
    endpoint_smoke: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
