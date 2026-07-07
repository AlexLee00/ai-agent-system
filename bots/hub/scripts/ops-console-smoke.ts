#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createOpsConsoleServer } from '../services/ops-console/server.ts';

function queryReadonly(schema, sql) {
  if (schema === 'sigma' && sql.includes('vault_audit')) {
    return Promise.resolve([{ created_at: new Date().toISOString(), action: 'validated', classifier: 'smoke', reasoning: 'smoke validation', applied: true, entry_id: 'smoke-vault' }]);
  }
  if (schema === 'public') {
    return Promise.resolve([{ created_at: new Date().toISOString(), caller_team: 'hub', agent: 'router', provider: 'claude-code-oauth', selected_route: 'claude-code/sonnet', success: true }]);
  }
  if (schema === 'agent') {
    return Promise.resolve([{ received_at: new Date().toISOString(), team: 'hub', bot_name: 'ops-console', severity: 'info', alarm_type: 'smoke', title: 'ops console smoke', message: 'read-only smoke event', status: 'open', id: 'alarm-smoke' }]);
  }
  if (schema === 'investment') {
    return Promise.resolve([{ triggered_at: new Date().toISOString(), guard_name: 'weak_symbol_quality_hard', symbol: 'BTC/USDT', action: 'BUY', decision: 'blocked', reason: 'smoke', id: 'guard-smoke' }]);
  }
  if (schema === 'blog') {
    return Promise.resolve([{ created_at: new Date().toISOString(), title: 'OPS Console smoke post', slug: 'ops-console-smoke', status: 'published', metadata: { writer_model: 'claude-code/sonnet' }, id: 'blog-smoke' }]);
  }
  if (schema === 'claude') {
    return Promise.resolve([{ created_at: new Date().toISOString(), rel_path: 'bots/hub/services/ops-console', outcome: 'completed', stage: 'smoke', test_pass: true, job_id: 'claude-smoke', id: 'claude-smoke' }]);
  }
  return Promise.resolve([]);
}

async function buildSessionSnapshot() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    health: { ok: true, checked: 3, failed: 0, services: [{ key: 'hub', ok: true }, { key: 'hub_ops_mcp', ok: true }, { key: 'blog_node_server', ok: true }] },
    launchd: { checked: 9, failedCount: 0, failed: [], runningWithLastExitCount: 0, runningWithLastExit: [] },
    metrics: {
      ska: { todayReservations: { rows: { total: 7, cancelled: 0, completed: 3 } }, cancelShadow: { ok: true } },
      sigma: { transition: { counts: { applied: 2, matched: 3 } } },
      hub: { chainRequired24h: { count: 0 } },
      luna: { weakSymbolHard24h: { count: 1 } },
      blog: { sonnetTags24h: { rows: { tagged: 4, sonnet: 4, fallback: 0 } } },
      darwin: { shadow: { total: 2, counts: { proposed: 2 } } },
    },
  };
}

function readSseEvent(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let buffer = '';
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('sse_timeout'));
    }, timeoutMs);
    fetch(url, { signal: controller.signal }).then(async (response) => {
      assert.equal(response.ok, true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: townsquare') && buffer.includes('smoke sse event')) {
          clearTimeout(timer);
          controller.abort();
          resolve(buffer);
          return;
        }
      }
    }).catch((error) => {
      if (error.name === 'AbortError' && buffer.includes('smoke sse event')) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const server = createOpsConsoleServer({ queryReadonly, buildSessionSnapshot, skipLaunchctl: true, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.readOnly, true);

    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.ok, true);
    assert.equal(Array.isArray(overview.teams), true);
    assert.equal(overview.teams.length >= 9, true);
    assert.equal(Array.isArray(overview.highlights), true);
    assert.equal(overview.readOnly, true);

    const town = await (await fetch(`${base}/api/townsquare?limit=20`)).json();
    assert.equal(town.ok, true);
    assert.equal(town.events.length >= 1, true);
    for (const event of town.events.slice(0, 3)) {
      assert.equal(Boolean(event.ts && event.from && event.to && event.text && event.tag && event.kind), true);
    }

    const ssePromise = readSseEvent(`${base}/api/stream`);
    server.pushTownSquareEvent({ ts: new Date().toISOString(), from: 'hub', to: 'orchestrator', text: 'smoke sse event', tag: 'smoke', kind: 'system', accent: true });
    const sseLog = await ssePromise;
    assert.match(sseLog, /smoke sse event/);

    console.log(JSON.stringify({
      ok: true,
      health,
      overview: { teams: overview.teams.length, highlights: overview.highlights.slice(0, 3) },
      townsquare: town.events.slice(0, 3),
      sseLog: sseLog.split(/\n/).filter(Boolean).slice(-4),
    }, null, 2));
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
