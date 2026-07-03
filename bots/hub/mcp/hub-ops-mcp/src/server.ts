#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const selector = require('../../../../../packages/core/lib/llm-model-selector.ts');
const pgPool = require('../../../../../packages/core/lib/pg-pool.ts');
const cycleBudget = require('../../../lib/llm/cycle-budget.ts');

export const HUB_OPS_MCP_TOOLS = [
  {
    name: 'hub-health',
    description: 'Return Hub live health via GET /hub/health/live. Read-only.',
  },
  {
    name: 'hub-metrics',
    description: 'Return compact Hub Prometheus metrics via GET /hub/metrics. Read-only.',
  },
  {
    name: 'hub-circuit',
    description: 'Return Hub LLM circuit state via GET /hub/llm/circuit. Read-only.',
  },
  {
    name: 'hub-routing',
    description: 'Return selector chain for a Hub selector key. Read-only local selector inspection.',
  },
  {
    name: 'hub-cost',
    description: 'Return recent Hub LLM cost/call summary from public.llm_routing_log. SELECT-only.',
  },
  {
    name: 'hub-trace',
    description: 'Return read-only Hub routing/alarm/event timeline for a traceId or cycleId.',
  },
];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4095;
const DEFAULT_HUB_BASE = 'http://127.0.0.1:7788';
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|credential)/i;

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hubBaseUrl() {
  return String(process.env.HUB_OPS_MCP_HUB_BASE_URL || process.env.HUB_BASE_URL || DEFAULT_HUB_BASE).replace(/\/+$/, '');
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function redact(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) out[key] = '[redacted]';
    else out[key] = redact(item, depth + 1);
  }
  return out;
}

async function fetchHub(path, { accept = 'json', timeoutMs = 5000 } = {}) {
  const token = String(process.env.HUB_AUTH_TOKEN || '').trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${hubBaseUrl()}${path}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(Math.max(1000, Math.min(30000, Number(timeoutMs) || 5000))),
  });
  const text = await response.text();
  let body = text;
  if (accept === 'json') {
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    path,
    body: redact(body),
  };
}

function parsePrometheusMetrics(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const samples = [];
  for (const line of rows) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
    if (!match) continue;
    samples.push({
      metric: match[1],
      labels: match[2] || '',
      value: Number(match[3]),
    });
  }
  const interesting = samples.filter((sample) => (
    /hub|llm|alarm|circuit|request|cost|queue|pg/i.test(sample.metric)
  )).slice(0, 80);
  return {
    ok: true,
    metricLines: rows.length,
    parsedSamples: samples.length,
    samples: interesting,
  };
}

function summarizeCircuit(body) {
  const local = body?.local_llm_circuits || {};
  const providers = body?.provider_circuits || {};
  const cooldowns = body?.provider_cooldowns || {};
  const localRows = Object.entries(local).map(([provider, state]) => ({
    provider,
    state: state?.state || null,
    failures: Number(state?.failures || 0),
  }));
  const providerRows = Object.entries(providers).map(([provider, state]) => ({
    provider,
    state: state?.state || null,
    failures: Number(state?.failures || 0),
  }));
  const coolingDown = Object.entries(cooldowns)
    .filter(([, state]) => state?.cooling_down)
    .map(([provider, state]) => ({
      provider,
      until: state?.until || null,
      retryAfterMs: Number(state?.retry_after_ms || state?.retryAfterMs || 0),
    }));
  return {
    ok: body?.ok === true,
    anyOpen: body?.any_open === true,
    local: localRows,
    providers: providerRows,
    coolingDown,
  };
}

function compactChain(chain = []) {
  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: entry.maxTokens,
    temperature: entry.temperature,
    timeoutMs: entry.timeoutMs,
  }));
}

async function buildCostSummary(args = {}, deps = {}) {
  const days = Math.max(1, Math.min(30, Number(args.days || 7) || 7));
  const limit = Math.max(1, Math.min(100, Number(args.limit || 40) || 40));
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const cycleId = String(args.cycleId || args.cycle_id || '').trim();
  try {
    const rows = await queryReadonly('public', `
      SELECT
        created_at::date AS day,
        COALESCE(provider, 'unknown') AS provider,
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE success IS TRUE)::int AS success_count,
        ROUND(AVG(duration_ms))::int AS avg_duration_ms,
        ROUND(SUM(COALESCE(NULLIF(estimated_cost_usd, 0), cost_usd))::numeric, 6)::float AS total_cost_usd
      FROM public.llm_routing_log
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY 1, 2
      ORDER BY day DESC, total_calls DESC
      LIMIT $2
    `, [days, limit]);
    const totalCalls = rows.reduce((sum, row) => sum + Number(row.total_calls || 0), 0);
    const totalCostUsd = rows.reduce((sum, row) => sum + Number(row.total_cost_usd || 0), 0);
    return {
      ok: true,
      mode: 'read_only_select',
      days,
      totalCalls,
      totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      rows,
      cycleBudget: cycleId
        ? await cycleBudget.buildCycleBudgetReport(cycleId, { queryReadonly })
        : null,
    };
  } catch (error) {
    return {
      ok: true,
      skipped: true,
      mode: 'read_only_select',
      reason: 'hub_cost_query_unavailable',
      error: String(error?.message || error).slice(0, 240),
      days,
      rows: [],
    };
  }
}

function normalizeTraceLimit(value, fallback = 80) {
  return Math.max(1, Math.min(200, Number(value || fallback) || fallback));
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function withTraceQueryTimeout(promise, label, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hub_trace_query_timeout:${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildTraceTimeline(args = {}, deps = {}) {
  const traceId = String(args.traceId || args.trace_id || '').trim();
  const cycleId = String(args.cycleId || args.cycle_id || '').trim();
  const limit = normalizeTraceLimit(args.limit);
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const hours = boundedInt(args.hours, 168, 1, 24 * 30);
  const scanLimit = boundedInt(args.scanLimit, Math.max(5000, limit * 25), limit, 50000);
  const timeoutMs = boundedInt(
    deps.traceQueryTimeoutMs || args.timeoutMs || process.env.HUB_OPS_MCP_TRACE_QUERY_TIMEOUT_MS,
    2500,
    100,
    10000,
  );
  if (!traceId && !cycleId) {
    return {
      ok: false,
      mode: 'read_only_select',
      error: 'traceId_or_cycleId_required',
      events: [],
    };
  }

  try {
    const columns = await withTraceQueryTimeout(queryReadonly('public', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'llm_routing_log'
        AND column_name = ANY($1::text[])
    `, [['trace_id', 'cycle_id']]), 'columns', timeoutMs);
    const columnSet = new Set(columns.map((row) => row.column_name));
    if (!columnSet.has('trace_id') || !columnSet.has('cycle_id')) {
      return {
        ok: true,
        skipped: true,
        mode: 'read_only_select',
        reason: 'cycle_trace_columns_missing',
        traceId: traceId || null,
        cycleId: cycleId || null,
        hours,
        scanLimit,
        events: [],
      };
    }

    const routingRows = await withTraceQueryTimeout(queryReadonly('public', `
      SELECT
        created_at,
        trace_id,
        cycle_id,
        provider,
        agent,
        caller_team,
        selector_key,
        selected_route,
        runtime_purpose,
        success,
        duration_ms,
        error
      FROM public.llm_routing_log
      WHERE ($1::text <> '' AND trace_id = $1)
         OR ($2::text <> '' AND cycle_id = $2)
      ORDER BY created_at DESC
      LIMIT $3
    `, [traceId, cycleId, limit]), 'routing', timeoutMs);

    const alarmRows = await withTraceQueryTimeout(queryReadonly('agent', `
      SELECT
        received_at AS created_at,
        team,
        bot_name,
        severity,
        alarm_type,
        title,
        status,
        metadata
      FROM agent.hub_alarms
      WHERE received_at >= NOW() - ($4::int * INTERVAL '1 hour')
        AND (
          ($1::text <> '' AND metadata->>'trace_id' = $1)
          OR ($2::text <> '' AND metadata->>'cycle_id' = $2)
          OR ($1::text <> '' AND metadata->>'incident_key' = $1)
        )
      ORDER BY received_at DESC
      LIMIT $3
    `, [traceId, cycleId, limit, hours]), 'alarms', timeoutMs).catch(() => []);

    const eventRows = await withTraceQueryTimeout(queryReadonly('agent', `
      WITH recent_events AS MATERIALIZED (
        SELECT
          created_at,
          event_type,
          team,
          bot_name,
          severity,
          title,
          trace_id,
          metadata
        FROM agent.event_lake
        WHERE created_at >= NOW() - ($4::int * INTERVAL '1 hour')
        ORDER BY created_at DESC
        LIMIT $5
      )
      SELECT
        created_at,
        event_type,
        team,
        bot_name,
        severity,
        title,
        trace_id,
        metadata
      FROM recent_events
      WHERE ($1::text <> '' AND trace_id = $1)
         OR ($1::text <> '' AND metadata->>'trace_id' = $1)
         OR ($2::text <> '' AND metadata->>'cycle_id' = $2)
      ORDER BY created_at DESC
      LIMIT $3
    `, [traceId, cycleId, limit, hours, scanLimit]), 'events', timeoutMs).catch(() => []);

    const events = [
      ...routingRows.map((row) => ({
        source: 'llm_routing_log',
        createdAt: row.created_at,
        type: 'llm_route',
        traceId: row.trace_id || null,
        cycleId: row.cycle_id || null,
        team: row.caller_team || null,
        agent: row.agent || null,
        summary: `${row.provider || 'unknown'} ${row.selected_route || ''}`.trim(),
        data: redact(row),
      })),
      ...alarmRows.map((row) => ({
        source: 'hub_alarms',
        createdAt: row.created_at,
        type: 'hub_alarm',
        traceId: row.metadata?.trace_id || row.metadata?.incident_key || null,
        cycleId: row.metadata?.cycle_id || null,
        team: row.team || null,
        agent: row.bot_name || null,
        summary: row.title || row.alarm_type || 'hub_alarm',
        data: redact(row),
      })),
      ...eventRows.map((row) => ({
        source: 'event_lake',
        createdAt: row.created_at,
        type: row.event_type || 'event',
        traceId: row.trace_id || row.metadata?.trace_id || null,
        cycleId: row.metadata?.cycle_id || null,
        team: row.team || null,
        agent: row.bot_name || null,
        summary: row.title || row.event_type || 'event',
        data: redact(row),
      })),
    ].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    return {
      ok: true,
      mode: 'read_only_select',
      traceId: traceId || null,
      cycleId: cycleId || null,
      hours,
      scanLimit,
      counts: {
        routing: routingRows.length,
        alarms: alarmRows.length,
        events: eventRows.length,
        total: events.length,
      },
      cycleBudget: cycleId
        ? await cycleBudget.buildCycleBudgetReport(cycleId, { queryReadonly })
        : null,
      events: events.slice(-limit),
    };
  } catch (error) {
    return {
      ok: true,
      skipped: true,
      mode: 'read_only_select',
      reason: 'hub_trace_query_unavailable',
      error: String(error?.message || error).slice(0, 240),
      traceId: traceId || null,
      cycleId: cycleId || null,
      events: [],
    };
  }
}

export async function callHubOpsTool(name, args = {}, deps = {}) {
  if (name === 'hub-health') {
    const response = await fetchHub('/hub/health/live', { timeoutMs: args.timeoutMs || 5000 });
    return {
      ok: response.ok,
      mode: 'read_only_proxy',
      response,
    };
  }
  if (name === 'hub-metrics') {
    const response = await fetchHub('/hub/metrics', { accept: 'text', timeoutMs: args.timeoutMs || 5000 });
    return {
      ok: response.ok,
      mode: 'read_only_proxy',
      status: response.status,
      metrics: parsePrometheusMetrics(response.body),
    };
  }
  if (name === 'hub-circuit') {
    const response = await fetchHub('/hub/llm/circuit', { timeoutMs: args.timeoutMs || 5000 });
    return {
      ok: response.ok,
      mode: 'read_only_proxy',
      status: response.status,
      circuit: summarizeCircuit(response.body),
    };
  }
  if (name === 'hub-routing') {
    const selectorKey = String(args.selectorKey || args.key || 'investment.luna').trim();
    const options = {
      agentName: args.agentName || args.agent || undefined,
      taskType: args.taskType || args.task_type || undefined,
      runtimePurpose: args.runtimePurpose || args.runtime_purpose || undefined,
      selectorVersion: args.selectorVersion || 'v3.0_oauth_4',
      rolloutPercent: Number(args.rolloutPercent ?? 100),
      rolloutKey: args.rolloutKey || `hub-ops-mcp:${selectorKey}`,
    };
    const chain = selector.selectLLMChain(selectorKey, options);
    const description = selector.describeLLMSelector(selectorKey, options);
    return {
      ok: true,
      mode: 'read_only_selector',
      selectorKey,
      routingSource: description.routingSource || null,
      primary: compactChain(chain)[0] || null,
      fallbacks: compactChain(chain).slice(1),
      chain: compactChain(chain),
    };
  }
  if (name === 'hub-cost') {
    return buildCostSummary(args, deps);
  }
  if (name === 'hub-trace') {
    return buildTraceTimeline(args, deps);
  }
  throw new Error(`unknown_tool:${name}`);
}

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: HUB_OPS_MCP_TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: await callHubOpsTool(name, args) }] } };
  }
  if (HUB_OPS_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: await callHubOpsTool(method, params) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

export function createHubOpsMcpServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'hub-ops-mcp',
          mode: 'read_only',
          toolCount: HUB_OPS_MCP_TOOLS.length,
          checkedAt: new Date().toISOString(),
        });
      }
      if (req.method === 'POST' && (req.url === '/' || req.url === '/rpc')) {
        return json(res, 200, await handleRpc(await readBody(req)));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message || String(error) });
    }
  });
}

export async function startServer({ port = null, host = DEFAULT_HOST } = {}) {
  const server = createHubOpsMcpServer();
  const listenPort = Number(port ?? argValue('--port', process.env.HUB_OPS_MCP_PORT || DEFAULT_PORT));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

async function main() {
  const { port, host } = await startServer();
  console.log(JSON.stringify({ ok: true, service: 'hub-ops-mcp', host, port, mode: 'read_only' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`hub-ops-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}
