#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const client = require('../../orchestrator/lib/jay-control-plan-client.ts');
  const originalFetch = global.fetch;
  const originalToken = process.env.HUB_AUTH_TOKEN;
  const originalBase = process.env.HUB_BASE_URL;
  const originalCallbackSecret = process.env.HUB_CONTROL_CALLBACK_SECRET;

  process.env.HUB_AUTH_TOKEN = 'jay-plan-integration-smoke-token';
  process.env.HUB_BASE_URL = 'http://hub-smoke.local';
  process.env.HUB_CONTROL_CALLBACK_SECRET = 'jay-smoke-callback-secret';

  const calls = [];
  global.fetch = (async (url, options) => {
    const headers = Object.fromEntries(
      Object.entries(options?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
    );
    calls.push({
      url,
      method: String(options?.method || 'GET').toUpperCase(),
      headers,
      body: options?.body ? JSON.parse(String(options.body)) : {},
    });

    if (String(url).endsWith('/hub/control/plan')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          run_id: 'run_smoke_1',
          status: 'draft',
          plan: {
            goal: 'smoke',
            team: 'luna',
            risk: 'low',
            requiresApproval: false,
            dryRun: true,
            steps: [{ id: 's1', tool: 'hub.health.query', args: {}, sideEffect: 'read_only' }],
            verify: [],
            playbook: { phases: [] },
            metadata: {},
          },
          approval: { required: false },
        }),
      };
    }
    if (String(url).endsWith('/hub/control/execute')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, run_id: 'run_smoke_1', status: 'dry_run_completed', result: [] }),
      };
    }
    if (String(url).endsWith('/hub/control/callback')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, run_id: 'run_smoke_1', status: 'approved' }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'not_found' }),
    };
  });

  try {
    const plan = await client.createControlPlanDraft({
      message: '루나팀 점검',
      goal: '루나팀 점검',
      team: 'luna',
    });
    assert.equal(plan?.ok, true, 'plan draft should succeed');

    const execute = await client.executeControlPlan({
      runId: 'run_smoke_1',
    });
    assert.equal(execute?.ok, true, 'execute should succeed');

    const callback = await client.submitControlCallback({
      callbackData: 'hub_control:approve:run_smoke_1:abc',
      fromId: '1',
      username: 'approver',
      chatId: '-100',
      threadId: '100',
    });
    assert.equal(callback?.ok, true, 'callback should succeed');

    const callbackRequest = calls.find((call) => call.url.endsWith('/hub/control/callback'));
    assert.ok(callbackRequest, 'callback request must be issued');
    assert.equal(
      callbackRequest?.headers?.['x-hub-control-callback-secret'],
      'jay-smoke-callback-secret',
      'callback secret header must be attached',
    );
    console.log('jay_control_plan_integration_smoke_ok');
  } finally {
    global.fetch = originalFetch;
    if (originalToken == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalToken;
    if (originalBase == null) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = originalBase;
    if (originalCallbackSecret == null) delete process.env.HUB_CONTROL_CALLBACK_SECRET;
    else process.env.HUB_CONTROL_CALLBACK_SECRET = originalCallbackSecret;
  }
}

main().catch((error) => {
  console.error(`jay_control_plan_integration_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
