#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    let started;
    started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function postJson(baseUrl, route, bearer, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function main() {
  const originalEnv = {
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN,
    HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES: process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES,
  };
  const authValue = 'hub-direct-provider-route-guard-auth-value';
  process.env.HUB_AUTH_TOKEN = authValue;
  delete process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;

  try {
    const { createHubApp } = require('../src/app.ts');
    const app = createHubApp({
      isShuttingDown: () => false,
      isStartupComplete: () => true,
    });

    await withServer(app, async (baseUrl) => {
      for (const route of ['/hub/llm/oauth', '/hub/llm/groq']) {
        const result = await postJson(baseUrl, route, authValue, {
          prompt: 'direct provider route guard smoke',
        });
        assert.equal(result.status, 403, `${route} must be blocked by default`);
        assert.equal(result.body.error, 'direct_llm_provider_route_disabled', `${route} must return guard error`);
      }
    });

    console.log(JSON.stringify({
      ok: true,
      direct_provider_routes_default: 'blocked',
    }));
  } finally {
    if (originalEnv.HUB_AUTH_TOKEN == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalEnv.HUB_AUTH_TOKEN;
    if (originalEnv.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES == null) delete process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
    else process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = originalEnv.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
  }
}

main().catch((error) => {
  console.error('[llm-direct-provider-route-guard-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
