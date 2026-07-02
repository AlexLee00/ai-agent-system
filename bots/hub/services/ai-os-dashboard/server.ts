#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pgPool = require('../../../../packages/core/lib/pg-pool.ts');
const cycleBudget = require('../../lib/llm/cycle-budget.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, 'web');
const DEFAULT_PORT = 4105;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HUB_BASE = 'http://127.0.0.1:7788';

function dashboardEnabled() {
  return process.env.AI_OS_DASHBOARD_ENABLED === 'true';
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function hubBaseUrl() {
  return String(process.env.AI_OS_DASHBOARD_HUB_BASE_URL || process.env.HUB_BASE_URL || DEFAULT_HUB_BASE).replace(/\/+$/, '');
}

function authHeaders() {
  const token = String(process.env.HUB_AUTH_TOKEN || '').trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function safePart(name, fn) {
  try {
    return { ok: true, name, data: await fn() };
  } catch (error) {
    return {
      ok: true,
      name,
      skipped: true,
      reason: `${name}_unavailable`,
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

async function fetchHub(pathname, timeoutMs = 3000) {
  const response = await fetch(`${hubBaseUrl()}${pathname}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let parsed = body;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = body.slice(0, 4000);
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

async function collectAgentRegistry() {
  const rows = await pgPool.queryReadonly('agent', `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
      COUNT(DISTINCT team)::int AS teams
    FROM agent.registry
  `, []);
  const row = rows?.[0] || {};
  return {
    total: Number(row?.total || 0),
    active: Number(row?.total || 0) - Number(row?.archived || 0),
    archived: Number(row?.archived || 0),
    teams: Number(row?.teams || 0),
  };
}

function collectLaunchd() {
  const output = execFileSync('/bin/launchctl', ['list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });
  const services = output.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^ai\./.test(parts[2]))
    .map(([pid, status, label]) => ({
      label,
      pid: pid === '-' ? null : Number(pid),
      status: Number(status),
      running: pid !== '-',
    }));
  return {
    total: services.length,
    running: services.filter((service) => service.running).length,
    services: services.slice(0, 120),
  };
}

async function collectHubKernel() {
  const [metrics, circuit] = await Promise.all([
    fetchHub('/hub/metrics', 3000).catch((error) => ({ ok: false, error: error?.message || String(error) })),
    fetchHub('/hub/llm/circuit', 3000).catch((error) => ({ ok: false, error: error?.message || String(error) })),
  ]);
  return { metrics, circuit };
}

async function collectLlmCost() {
  const rows = await pgPool.queryReadonly('public', `
    SELECT
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE success IS TRUE)::int AS success,
      ROUND(SUM(COALESCE(NULLIF(estimated_cost_usd, 0), cost_usd))::numeric, 6)::float AS cost_usd
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - INTERVAL '24 hours'
  `, []);
  const row = rows?.[0] || {};
  return {
    calls24h: Number(row.calls || 0),
    success24h: Number(row.success || 0),
    costUsd24h: Number(row.cost_usd || 0),
    cycleBudget: await collectRecentCycleBudget().catch((error) => ({
      skipped: true,
      reason: 'cycle_budget_unavailable',
      error: String(error?.message || error).slice(0, 160),
    })),
  };
}

async function collectRecentCycleBudget() {
  const rows = await pgPool.queryReadonly('public', `
    SELECT cycle_id, COUNT(*)::int AS calls
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - INTERVAL '6 hours'
      AND cycle_id IS NOT NULL
      AND cycle_id <> ''
    GROUP BY cycle_id
    ORDER BY calls DESC
    LIMIT 1
  `, []);
  const cycleId = rows?.[0]?.cycle_id;
  if (!cycleId) return { skipped: true, reason: 'recent_cycle_not_found' };
  return cycleBudget.buildCycleBudgetReport(cycleId, { queryReadonly: pgPool.queryReadonly });
}

async function collectHubAlarms() {
  const rows = await pgPool.queryReadonly('agent', `
    SELECT
      severity,
      status,
      COUNT(*)::int AS count
    FROM agent.hub_alarms
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY severity, status
    ORDER BY count DESC
    LIMIT 20
  `, []);
  return { rows };
}

async function collectTracePanel() {
  const columns = await pgPool.queryReadonly('public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
      AND column_name = ANY($1::text[])
  `, [['trace_id', 'cycle_id']]);
  const columnSet = new Set(columns.map((row) => row.column_name));
  if (!columnSet.has('trace_id') || !columnSet.has('cycle_id')) {
    return { skipped: true, reason: 'cycle_trace_columns_missing', rows: [] };
  }
  const rows = await pgPool.queryReadonly('public', `
    SELECT created_at, trace_id, cycle_id, caller_team, agent, provider, selected_route, success
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - INTERVAL '6 hours'
      AND (trace_id IS NOT NULL OR cycle_id IS NOT NULL)
    ORDER BY created_at DESC
    LIMIT 30
  `, []);
  return { rows };
}

export async function collectAiOsSnapshot(now = new Date()) {
  const parts = await Promise.all([
    safePart('agentRegistry', collectAgentRegistry),
    safePart('launchd', collectLaunchd),
    safePart('hubKernel', collectHubKernel),
    safePart('llmCost', collectLlmCost),
    safePart('hubAlarms', collectHubAlarms),
    safePart('traceTimeline', collectTracePanel),
  ]);
  const snapshot = {
    ok: true,
    generatedAt: now.toISOString(),
    readOnly: true,
    parts: Object.fromEntries(parts.map((part) => [part.name, part])),
  };
  return snapshot;
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const routePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(routePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, safePath);
  if (!filePath.startsWith(WEB_ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return text(res, 404, 'not found');
  }
  const ext = path.extname(filePath);
  const type = ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';
  text(res, 200, fs.readFileSync(filePath, 'utf8'), type);
}

function createSseState(limit = 100) {
  return { seq: 0, buffer: [], subscribers: new Set(), limit };
}

function pushSse(state, event) {
  state.seq += 1;
  const row = { id: state.seq, event };
  state.buffer.push(row);
  if (state.buffer.length > state.limit) state.buffer.shift();
  const payload = `id: ${row.id}\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`;
  for (const subscriber of Array.from(state.subscribers)) {
    try {
      if (subscriber.destroyed || subscriber.writableEnded) {
        state.subscribers.delete(subscriber);
        continue;
      }
      subscriber.write(payload);
    } catch {
      state.subscribers.delete(subscriber);
    }
  }
  return row;
}

function writeSse(res, name, data, id = null) {
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAiOsDashboardServer(options = {}) {
  const enabledFn = options.enabledFn || dashboardEnabled;
  const collectSnapshot = options.collectSnapshot || collectAiOsSnapshot;
  const sse = createSseState();
  let timer = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'ai-os-dashboard', enabled: enabledFn(), readOnly: true });
    }
    if (url.pathname === '/api/os/snapshot') {
      if (!enabledFn()) return json(res, 404, { ok: false, disabled: true, error: 'ai_os_dashboard_disabled' });
      return json(res, 200, await collectSnapshot());
    }
    if (url.pathname === '/api/os/stream') {
      if (!enabledFn()) return json(res, 404, { ok: false, disabled: true, error: 'ai_os_dashboard_disabled' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const lastId = Number(req.headers['last-event-id'] || 0) || 0;
      writeSse(res, 'hello', { ok: true, lastId }, null);
      for (const row of sse.buffer.filter((item) => item.id > lastId)) {
        writeSse(res, 'snapshot', row.event, row.id);
      }
      sse.subscribers.add(res);
      req.on('close', () => sse.subscribers.delete(res));
      return;
    }
    serveStatic(req, res);
  });

  server.startSnapshotLoop = function startSnapshotLoop(intervalMs = Number(process.env.AI_OS_DASHBOARD_INTERVAL_MS || 10000) || 10000) {
    if (timer) return;
    timer = setInterval(async () => {
      if (!enabledFn()) return;
      try {
        pushSse(sse, await collectSnapshot());
      } catch (error) {
        pushSse(sse, { ok: false, error: String(error?.message || error).slice(0, 240) });
      }
    }, Math.max(1000, intervalMs));
  };
  server.stopSnapshotLoop = function stopSnapshotLoop() {
    if (timer) clearInterval(timer);
    timer = null;
  };
  server.pushSnapshot = (snapshot) => pushSse(sse, snapshot);
  server.sseState = sse;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AI_OS_DASHBOARD_PORT || DEFAULT_PORT) || DEFAULT_PORT;
  const host = String(process.env.AI_OS_DASHBOARD_HOST || DEFAULT_HOST);
  const server = createAiOsDashboardServer();
  server.startSnapshotLoop();
  server.listen(port, host, () => {
    console.log(`[ai-os-dashboard] listening http://${host}:${port} enabled=${dashboardEnabled()}`);
  });
}
