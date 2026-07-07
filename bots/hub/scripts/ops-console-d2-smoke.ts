#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createOpsConsoleServer } from '../services/ops-console/server.ts';

const TEAMS = ['hub', 'ska', 'luna', 'claude', 'blog', 'sigma', 'darwin', 'orchestrator', 'write'];

function queryReadonly(schema, sql, params = []) {
  const now = new Date().toISOString();
  if (/memory_transitions/.test(sql) || /source_ref/.test(sql)) {
    return Promise.resolve([{
      created_at: now,
      action: 'classified',
      classifier: 'smoke',
      reasoning: `${params[0] || 'team'} memory transition smoke`,
      applied: true,
      title: `${params[0] || 'team'} validated memory`,
      source_ref: { team: params[0] || 'hub', table: 'smoke' },
    }]);
  }
  if (schema === 'public') {
    return Promise.resolve([{ created_at: now, caller_team: 'hub', agent: 'luna', provider: 'claude-code', selected_route: 'claude-code/sonnet', success: true, routing_source: 'claude-code/sonnet', count: 3 }]);
  }
  if (schema === 'hub') {
    return Promise.resolve([{ total: 10, matched: 9, match_pct: 90 }]);
  }
  if (schema === 'agent' && /hub_alarms/.test(sql)) {
    return Promise.resolve([{ received_at: now, team: 'hub', bot_name: 'ops-console', severity: 'info', alarm_type: 'smoke', title: 'hub alarm', message: 'smoke', status: 'open', id: 'alarm-smoke', count: 2 }]);
  }
  if (schema === 'agent' && /event_lake/.test(sql)) {
    return Promise.resolve([{ created_at: now, event_type: 'smoke_event', title: 'event lake smoke', severity: 'info', count: 4, metadata: {} }]);
  }
  if (schema === 'reservation') {
    return Promise.resolve([{ total: 7, cancelled: 1, completed: 3 }]);
  }
  if (schema === 'investment' && /guard_events/.test(sql)) {
    return Promise.resolve([{ triggered_at: now, guard_name: 'loss_limit_guard', symbol: 'BTC/USDT', action: 'SELL', decision: 'blocked', reason: 'smoke', id: 'guard-smoke' }]);
  }
  if (schema === 'investment' && /trade_journal/.test(sql) && /GROUP BY/.test(sql)) {
    return Promise.resolve([{ market: 'crypto', strategy_family: 'trend', open_count: 2 }]);
  }
  if (schema === 'investment' && /trade_journal/.test(sql) && /SUM/.test(sql)) {
    return Promise.resolve([{ pnl_net: 12.34, closed_count: 2 }]);
  }
  if (schema === 'investment' && /trade_journal/.test(sql)) {
    return Promise.resolve([{ market: 'crypto', exchange: 'binance', symbol: 'BTC/USDT', entry_size: 0.1, entry_price: 60000, pnl_net: 12, status: 'open' }]);
  }
  if (schema === 'investment') {
    return Promise.resolve([{ shadow: 'regime_llm', latest: now }]);
  }
  if (schema === 'claude') {
    return Promise.resolve([{ created_at: now, rel_path: 'docs/auto_dev/smoke.md', outcome: 'completed', stage: 'review', test_pass: true, kind: 'completed', count: 1 }]);
  }
  if (schema === 'blog' && /book_review_queue/.test(sql)) {
    return Promise.resolve([{ status: 'queued', count: 2 }]);
  }
  if (schema === 'blog' && /crank_scores/.test(sql)) {
    return Promise.resolve([{ scored_date: now, post_id: 1, overall: 72, crank_total: 70, dia_total: 71, geo_total: 75 }]);
  }
  if (schema === 'blog' && /served_model/.test(sql)) {
    return Promise.resolve([{ served_model: 'claude-code/sonnet', count: 5 }]);
  }
  if (schema === 'blog') {
    return Promise.resolve([{ today: 1, seven_days: 5, created_at: now, title: 'blog smoke', slug: 'blog-smoke', status: 'published', metadata: { writer_model: 'claude-code/sonnet' }, id: 'blog-smoke' }]);
  }
  if (schema === 'sigma' && /COUNT\(\*\)::int AS total FROM sigma\.vault_entries/.test(sql)) return Promise.resolve([{ total: 42 }]);
  if (schema === 'sigma' && /abstraction_level/.test(sql) && /validation_state/.test(sql) && /GROUP BY 1, 2/.test(sql)) return Promise.resolve([{ abstraction_level: 'pattern', validation_state: 'validated', count: 7 }]);
  if (schema === 'sigma' && /SELECT created_at, title, source, status/.test(sql)) return Promise.resolve([{ created_at: now, title: 'sigma feed', source: 'luna', status: 'classified' }]);
  if (schema === 'sigma') return Promise.resolve([{ created_at: now, action: 'classified', classifier: 'smoke', applied: true, reasoning: 'sigma smoke' }]);
  return Promise.resolve([]);
}

async function buildSessionSnapshot() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    health: {
      ok: true,
      checked: 5,
      failed: 0,
      services: [
        { key: 'hub', ok: true },
        { key: 'hub_ops_mcp', ok: true },
        { key: 'luna_ops_mcp', ok: true },
        { key: 'ska_ops_mcp', ok: true },
        { key: 'blog_node_server', ok: true },
      ],
    },
    launchd: {
      checked: 189,
      failedCount: 0,
      failed: [],
      runningWithLastExitCount: 0,
      runningWithLastExit: [],
    },
    metrics: {
      ska: { todayReservations: { rows: { total: 7, cancelled: 1, completed: 3 } }, cancelShadow: { ok: true } },
      sigma: { transition: { counts: { applied: 2, matched: 3 } } },
      hub: { chainRequired24h: { count: 0 } },
      luna: { weakSymbolHard24h: { count: 1 } },
      blog: { sonnetTags24h: { rows: { tagged: 4, sonnet: 4, fallback: 0 } } },
      darwin: { shadow: { total: 2, counts: { proposed: 2 } } },
    },
  };
}

function makeFixtures(tmp) {
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(workspace, 'reservation'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'sigma'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'reservation', 'cancel-shadow-diff-history.jsonl'), [
    JSON.stringify({ day: 'd-2', diff: 0 }),
    JSON.stringify({ day: 'd-1', diff: 1 }),
    JSON.stringify({ day: 'd', diff: 0 }),
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'sigma', 'transition-telemetry.jsonl'), JSON.stringify({ type: 'transition', counts: { applied: 2, matched: 3 } }) + '\n');

  const bridgeRoot = path.join(tmp, 'bridge');
  fs.mkdirSync(path.join(bridgeRoot, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(bridgeRoot, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(bridgeRoot, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, 'archive', 'TASK-0001.md'), '# TASK-0001\n');
  fs.writeFileSync(path.join(bridgeRoot, 'archive', 'REPORT-0001.md'), '# REPORT-0001\nstatus: done\n');
  return { workspace, bridgeRoot, pushSubscriptionPath: path.join(tmp, 'push-subscriptions.json') };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-console-d2-'));
  const fixtures = makeFixtures(tmp);
  const server = createOpsConsoleServer({
    queryReadonly,
    buildSessionSnapshot,
    skipLaunchctl: true,
    ...fixtures,
    vapidPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    vapidPrivateKey: 'private-smoke-key',
    vapidSubject: 'mailto:ops-console-smoke@localhost',
    webPush: { setVapidDetails() {}, sendNotification() { return Promise.resolve(); } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen2.5' }, { id: 'llama3.2' }, { id: 'mistral' }, { id: 'phi4' }, { id: 'gemma3' }] }) }),
    port: 0,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const samples = {};
    for (const team of TEAMS) {
      const detail = await (await fetch(`${base}/api/team/${team}`)).json();
      assert.equal(detail.ok, true, `${team} ok`);
      assert.equal(detail.team.id, team, `${team} id`);
      assert.equal(typeof detail.status, 'string', `${team} status`);
      assert.equal(Boolean(detail.jobs && Number.isFinite(Number(detail.jobs.total))), true, `${team} jobs`);
      assert.equal(Array.isArray(detail.panels), true, `${team} panels array`);
      assert.equal(detail.panels.length >= 1, true, `${team} panels`);
      assert.equal(Array.isArray(detail.memoryTransitions), true, `${team} memory transitions array`);
      if (['hub', 'luna', 'sigma'].includes(team)) samples[team] = detail.panels.slice(0, 2);
    }
    assert.equal(samples.sigma[0].rows[0].total, 42);
    assert.equal(samples.sigma[1].rows[0].abstraction_level, 'pattern');

    const filtered = await (await fetch(`${base}/api/townsquare?team=luna&limit=20`)).json();
    assert.equal(filtered.ok, true);
    assert.equal(filtered.events.every((event) => event.from === 'luna' || event.to === 'luna' || String(event.tag || '').includes('luna')), true);

    const bridge = await (await fetch(`${base}/api/bridge`)).json();
    const vapid = await (await fetch(`${base}/api/push/vapid-public`)).json();
    const overview = await (await fetch(`${base}/api/overview`)).json();
    const town = await (await fetch(`${base}/api/townsquare?limit=5`)).json();
    assert.equal(bridge.ok, true);
    assert.equal(vapid.ok, true);
    assert.equal(overview.ok, true);
    assert.equal(town.ok, true);

    console.log(JSON.stringify({
      ok: true,
      teams: TEAMS.length,
      samples,
      memoryTransitions: { format: 'array', checkedTeams: TEAMS.length },
      filteredTown: filtered.events.slice(0, 3),
      regression: {
        overviewTeams: overview.teams.length,
        townEvents: town.events.length,
        bridgeItems: bridge.items.length,
        pushConfigured: vapid.configured,
      },
    }, null, 2));
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
