#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createOpsConsoleServer } from '../services/ops-console/server.ts';

function queryReadonly(schema, sql, params = []) {
  const now = new Date().toISOString();
  if (schema === 'sigma' && /FROM sigma\.vault_entries/.test(sql) && /source_ref/.test(sql)) {
    return Promise.resolve([
      {
        id: 'kg-1',
        title: 'validated luna pattern',
        source: 'luna',
        status: 'active',
        validation_state: 'validated',
        created_at: now,
        meta: { libraryCoords: { validation_state: 'validated' } },
        source_ref: { team: 'luna', table: 'trade_journal', id: 'trade-1' },
      },
      {
        id: 'kg-2',
        title: 'blog crank lesson',
        source: 'blog',
        status: 'active',
        validation_state: 'unverified',
        created_at: now,
        meta: {},
        source_ref: { team: 'blog', table: 'posts', id: 'post-1' },
      },
    ]);
  }
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
    return Promise.resolve([{ received_at: now, team: 'hub', bot_name: 'ops-console', severity: 'critical', alarm_type: 'smoke', title: 'hub alarm', message: 'smoke', status: 'open', id: 'alarm-smoke', count: 2 }]);
  }
  if (schema === 'agent' && /event_lake/.test(sql)) {
    return Promise.resolve([{ created_at: now, event_type: 'smoke_event', title: 'event lake smoke', severity: 'info', count: 4, metadata: {} }]);
  }
  if (schema === 'reservation') {
    return Promise.resolve([{ total: 7, cancelled: 1, completed: 3 }]);
  }
  if (schema === 'investment' && /guard_events/.test(sql)) {
    return Promise.resolve([{ triggered_at: now, guard_name: 'loss_limit_guard', symbol: 'BTC/USDT', action: 'SELL', decision: 'blocked', severity: 'high', reason: 'smoke', id: 'guard-smoke' }]);
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
    return Promise.resolve([{ created_at: now, today: 1, seven_days: 5, title: 'blog smoke', slug: 'blog-smoke', status: 'published', metadata: { writer_model: 'claude-code/sonnet' }, id: 'blog-smoke' }]);
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
      ska: { todayReservations: { rows: { total: 7, cancelled: 1, completed: 3 } } },
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
  fs.writeFileSync(path.join(workspace, 'sigma', 'transition-telemetry.jsonl'), JSON.stringify({ type: 'transition', counts: { applied: 2, matched: 3 } }) + '\n');

  const bridgeRoot = path.join(tmp, 'bridge');
  fs.mkdirSync(path.join(bridgeRoot, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(bridgeRoot, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(bridgeRoot, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, 'archive', 'TASK-0001.md'), '# TASK-0001\n');
  fs.writeFileSync(path.join(bridgeRoot, 'archive', 'REPORT-0001.md'), '# REPORT-0001\nstatus: done\n');
  return { workspace, bridgeRoot, pushSubscriptionPath: path.join(tmp, 'push-subscriptions.json') };
}

const env = {
  SIGMA_TRANSITION_ENABLED: 'true',
  SIGMA_DEDUPE_ENABLED: 'false',
  SIGMA_SHORT_TERM_ENABLED: 'shadow',
  SIGMA_LIBRARIAN_ENABLED: '',
  HUB_ALARM_LIFECYCLE_ENABLED: 'enabled',
  HUB_RESILIENCE_ENABLED: 'off',
  LLM_AUTO_ROUTING_ENABLED: 'shadow',
  BLOG_WRITER_MODEL: 'claude-code/sonnet',
  BLOG_AB_STRICT_FAMILY: 'true',
  BLOG_LIFECYCLE_INJECT_ENABLED: 'false',
  LUNA_WEAK_SYMBOL_HARD_ENABLED: '1',
  LUNA_LIFECYCLE_INJECT_ENABLED: 'preview',
  EVENT_LAKE_RETENTION_ENABLED: '',
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-console-d3-'));
  const fixtures = makeFixtures(tmp);
  const server = createOpsConsoleServer({
    queryReadonly,
    buildSessionSnapshot,
    skipLaunchctl: true,
    env,
    ...fixtures,
    vapidPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    vapidPrivateKey: 'private-smoke-key',
    vapidSubject: 'mailto:ops-console-smoke@localhost',
    webPush: { setVapidDetails() {}, sendNotification() { return Promise.resolve(); } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen2.5' }] }) }),
    port: 0,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const gates = await (await fetch(`${base}/api/gates`)).json();
    assert.equal(gates.ok, true);
    assert.equal(gates.readOnly, true);
    assert(gates.gates.length >= 13, 'gate console must expose at least 13 gates');
    const states = new Set(gates.gates.map((row) => row.state));
    for (const state of ['on', 'off', 'shadow', 'unset']) assert(states.has(state), `missing gate state ${state}`);

    const postGate = await fetch(`${base}/api/gates`, { method: 'POST' });
    assert.equal(postGate.status, 405, 'gate console must not expose mutation route');

    const graph = await (await fetch(`${base}/api/knowledge-graph?limit=5`)).json();
    assert.equal(graph.ok, true);
    assert.equal(graph.readOnly, true);
    assert(graph.nodes.length >= 2, 'knowledge graph nodes');
    assert(graph.edges.length >= 1, 'knowledge graph edges');
    assert(graph.nodes.some((node) => node.validated === true), 'validated node highlight');

    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const replay = await (await fetch(`${base}/api/townsquare?replay=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(now.toISOString())}&limit=20`)).json();
    assert.equal(replay.ok, true);
    assert.equal(replay.replay, true);
    assert(replay.events.length >= 1, 'replay events');

    const futureFrom = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const futureTo = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const emptyReplay = await (await fetch(`${base}/api/townsquare?replay=1&from=${encodeURIComponent(futureFrom)}&to=${encodeURIComponent(futureTo)}&limit=20`)).json();
    assert.equal(emptyReplay.ok, true);
    assert.equal(emptyReplay.replay, true);
    assert.equal(emptyReplay.events.length, 0, 'empty replay must not inject live placeholder');

    const highlight = await (await fetch(`${base}/api/highlight`)).json();
    assert.equal(highlight.ok, true);
    assert.equal(highlight.costUsd, 0);
    assert.equal(highlight.lines.length, 3);

    const sigma = await (await fetch(`${base}/api/team/sigma`)).json();
    assert.equal(sigma.ok, true);
    assert(sigma.panels.some((panel) => panel.kind === 'knowledgeGraph' && panel.graph?.nodes?.length >= 2), 'sigma detail graph panel');

    const overview = await (await fetch(`${base}/api/overview`)).json();
    const bridge = await (await fetch(`${base}/api/bridge`)).json();
    const vapid = await (await fetch(`${base}/api/push/vapid-public`)).json();
    const town = await (await fetch(`${base}/api/townsquare?limit=5`)).json();
    assert.equal(overview.ok, true);
    assert(overview.teams.length >= 9, 'D1 team grid regression');
    assert.equal(bridge.ok, true, 'D1.5 bridge regression');
    assert.equal(vapid.ok, true, 'D1.5 push public regression');
    assert.equal(town.ok, true, 'D1 townsquare regression');

    console.log(JSON.stringify({
      ok: true,
      gates: { count: gates.gates.length, states: Array.from(states).sort() },
      knowledgeGraph: { nodes: graph.nodes.length, edges: graph.edges.length },
      replay: { events: replay.events.length, from: replay.from, to: replay.to },
      emptyReplay: { events: emptyReplay.events.length, from: emptyReplay.from, to: emptyReplay.to },
      highlight: highlight.lines,
      readOnly: { gateMutationStatus: postGate.status, mutationRoutes: 0 },
      regression: {
        overviewTeams: overview.teams.length,
        sigmaGraphPanel: true,
        bridgeItems: bridge.items.length,
        vapidConfigured: vapid.configured,
        townEvents: town.events.length,
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
