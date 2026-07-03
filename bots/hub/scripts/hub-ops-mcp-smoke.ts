#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  HUB_OPS_MCP_TOOLS,
  callHubOpsTool,
  createHubOpsMcpServer,
  startServer,
} from '../mcp/hub-ops-mcp/src/server.ts';

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function withFixtureHub(work) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/hub/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'hub-fixture', secret: 'should-redact' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/hub/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end([
        '# HELP hub_requests_total requests',
        'hub_requests_total{route="/hub/health"} 7',
        'llm_circuit_state{provider="groq"} 0',
        'unrelated_metric 5',
      ].join('\n'));
      return;
    }
    if (req.method === 'GET' && req.url === '/hub/llm/circuit') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        any_open: false,
        local_llm_circuits: { 'local/qwen': { state: 'CLOSED', failures: 0 } },
        provider_circuits: { groq: { state: 'CLOSED', failures: 0 } },
        provider_cooldowns: {},
      }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/hub/llm/selector')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = url.searchParams.get('key') || 'fixture.selector';
      if (key === 'unknown.disabled') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'fixture_selector_unavailable' }));
        return;
      }
      const timeoutMs = key === 'claude.archer.tech_analysis' ? 300_000 : 30_000;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mode: 'read_only_selector',
        selectorKey: key,
        routingSource: 'oauth4',
        source: 'selector_key',
        effectiveTimeoutMs: timeoutMs,
        timeoutProfile: { source: 'fixture', timeoutMs },
        chain: [
          { provider: 'openai-oauth', model: 'gpt-5.4-mini', route: 'openai-oauth/gpt-5.4-mini', timeoutMs, providerTier: 'primary', fallbackIndex: 0 },
          { provider: 'groq', model: 'openai/gpt-oss-20b', route: 'groq/openai/gpt-oss-20b', timeoutMs: 30_000, providerTier: 'fallback', fallbackIndex: 1 },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const previous = process.env.HUB_OPS_MCP_HUB_BASE_URL;
  process.env.HUB_OPS_MCP_HUB_BASE_URL = `http://127.0.0.1:${address.port}`;
  try {
    return await work();
  } finally {
    if (previous == null) delete process.env.HUB_OPS_MCP_HUB_BASE_URL;
    else process.env.HUB_OPS_MCP_HUB_BASE_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMcpServer(work) {
  const server = createHubOpsMcpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await work(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertReadOnlySurface() {
  const toolNames = HUB_OPS_MCP_TOOLS.map((tool) => tool.name);
  assert.deepEqual(toolNames.sort(), ['hub-circuit', 'hub-cost', 'hub-health', 'hub-metrics', 'hub-routing', 'hub-trace'].sort());
  for (const tool of HUB_OPS_MCP_TOOLS) {
    assert.equal(/apply|write|delete|reset|mutation|restart|kill/i.test(`${tool.name} ${tool.description}`), false);
  }
}

async function assertCostQuerySelectOnly() {
  const calls = [];
  const result = await callHubOpsTool('hub-cost', { days: 1 }, {
    queryReadonly: async (schema, sql, params) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'public');
      assert.match(String(sql).trim(), /^SELECT/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      return [{
        day: '2026-07-02',
        provider: 'groq',
        total_calls: 3,
        success_count: 3,
        avg_duration_ms: 1200,
        total_cost_usd: 0.001,
      }];
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalCalls, 3);
  assert.equal(calls.length, 1);
}

async function assertTraceQuerySelectOnly() {
  const calls = [];
  const result = await callHubOpsTool('hub-trace', { traceId: 'trace-smoke', limit: 5 }, {
    queryReadonly: async (schema, sql, params) => {
      calls.push({ schema, sql, params });
      assert.match(String(sql).trim(), /^SELECT/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      if (String(sql).includes('information_schema.columns')) {
        return [{ column_name: 'trace_id' }, { column_name: 'cycle_id' }];
      }
      if (String(sql).includes('public.llm_routing_log')) {
        return [{
          created_at: '2026-07-02T00:00:00.000Z',
          trace_id: 'trace-smoke',
          cycle_id: 'cycle-smoke',
          provider: 'groq',
          caller_team: 'hub',
          agent: 'smoke',
          selected_route: 'groq/model',
          success: true,
        }];
      }
      if (String(sql).includes('agent.hub_alarms')) return [];
      if (String(sql).includes('agent.event_lake')) return [];
      return [];
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.counts.routing, 1);
  assert.ok(calls.length >= 2);

  const skipped = await callHubOpsTool('hub-trace', { traceId: 'trace-smoke' }, {
    queryReadonly: async () => [],
  });
  assert.equal(skipped.skipped, true);

  const started = Date.now();
  const bounded = await callHubOpsTool('hub-trace', { traceId: 'trace-smoke', limit: 5, hours: 24 }, {
    traceQueryTimeoutMs: 25,
    queryReadonly: async (schema, sql) => {
      assert.match(String(sql).trim(), /^(SELECT|WITH)/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      if (String(sql).includes('information_schema.columns')) {
        return [{ column_name: 'trace_id' }, { column_name: 'cycle_id' }];
      }
      if (String(sql).includes('public.llm_routing_log')) return [];
      if (String(sql).includes('agent.hub_alarms')) {
        assert.match(String(sql), /received_at AS created_at/);
        return [];
      }
      if (String(sql).includes('recent_events')) {
        return new Promise(() => {});
      }
      return [];
    },
  });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.counts.events, 0);
  assert.ok(Date.now() - started < 1000, 'hub-trace must not hang when an optional source stalls');
}

async function assertDirectTools() {
  await withFixtureHub(async () => {
    const health = await callHubOpsTool('hub-health');
    assert.equal(health.response.status, 200);
    assert.equal(health.response.body.secret, '[redacted]');

    const metrics = await callHubOpsTool('hub-metrics');
    assert.equal(metrics.ok, true);
    assert.ok(metrics.metrics.parsedSamples >= 2);

    const circuit = await callHubOpsTool('hub-circuit');
    assert.equal(circuit.circuit.anyOpen, false);
    assert.equal(circuit.circuit.providers[0].provider, 'groq');
  });

  await withFixtureHub(async () => {
    const routing = await callHubOpsTool('hub-routing', {
      selectorKey: 'investment.luna',
      agentName: 'luna',
      selectorVersion: 'v3.0_oauth_4',
    });
    assert.equal(routing.ok, true);
    assert.equal(routing.mode, 'read_only_selector_proxy');
    assert.ok(routing.chain.length > 0);
    assert.ok(routing.primary.provider);
    assert.ok(Object.prototype.hasOwnProperty.call(routing, 'effectiveTimeoutMs'));
    assert.ok(routing.timeoutProfile);
  });

  const previousProfilesEnabled = process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED;
  process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED = 'true';
  try {
    await withFixtureHub(async () => {
      const archerRouting = await callHubOpsTool('hub-routing', {
        selectorKey: 'claude.archer.tech_analysis',
        selectorVersion: 'v3.0_oauth_4',
      });
      assert.equal(archerRouting.ok, true);
      assert.equal(archerRouting.effectiveTimeoutMs, 300_000);
      assert.equal(archerRouting.timeoutProfile.source, 'fixture');
    });
  } finally {
    if (previousProfilesEnabled == null) delete process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED;
    else process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED = previousProfilesEnabled;
  }

  const failedRouting = await withFixtureHub(async () => callHubOpsTool('hub-routing', {
    selectorKey: 'unknown.disabled',
    timeoutMs: 1,
  }));
  assert.equal(failedRouting.ok, false);
  assert.equal(failedRouting.mode, 'read_only_selector_proxy');
}

async function assertRpcServer() {
  await withFixtureHub(async () => {
    await withMcpServer(async (base) => {
      const listed = await postJson(`${base}/rpc`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.result.tools.length, 6);

      const called = await postJson(`${base}/rpc`, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hub-health', arguments: {} },
      });
      assert.equal(called.status, 200);
      assert.equal(called.body.result.content[0].json.response.status, 200);
    });
  });
}

async function assertHardServerPath() {
  await withFixtureHub(async () => {
    const started = await startServer({ port: 0 });
    try {
      const health = await fetch(`http://${started.host}:${started.port}/health`).then((res) => res.json());
      assert.equal(health.ok, true);
      assert.equal(health.service, 'hub-ops-mcp');
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  });
}

export async function runHubOpsMcpSmoke() {
  assertReadOnlySurface();
  await assertDirectTools();
  await assertCostQuerySelectOnly();
  await assertTraceQuerySelectOnly();
  await assertRpcServer();
  await assertHardServerPath();
  return {
    ok: true,
    smoke: 'hub-ops-mcp',
    tools: HUB_OPS_MCP_TOOLS.map((tool) => tool.name),
    readOnly: true,
  };
}

async function main() {
  const result = await runHubOpsMcpSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('hub-ops-mcp-smoke ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`hub-ops-mcp-smoke failed: ${error?.message || error}`);
    process.exit(1);
  });
}
