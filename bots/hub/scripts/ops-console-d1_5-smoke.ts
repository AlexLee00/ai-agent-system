#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { classifyOpsPushEvent } from '../lib/ops-push-router.ts';
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
    return Promise.resolve([{ triggered_at: new Date().toISOString(), guard_name: 'loss_limit_guard', symbol: 'BTC/USDT', action: 'SELL', decision: 'blocked', reason: 'smoke', id: 'guard-smoke' }]);
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

function makeBridgeFixture(root) {
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', 'TASK-0003.md'), '# TASK-0003: pending smoke\n');
  fs.writeFileSync(path.join(root, 'archive', 'TASK-0002.md'), '# TASK-0002: archived smoke\n');
  fs.writeFileSync(path.join(root, 'archive', 'REPORT-0002.md'), '# REPORT-0002\nstatus: done\n');
  fs.writeFileSync(path.join(root, 'verify-log.jsonl'), JSON.stringify({ taskId: 'TASK-0002', verdict: 'verified', ts: new Date().toISOString() }) + '\n');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-console-d1-5-'));
  const bridgeRoot = path.join(tmp, 'bridge');
  const pushSubscriptionPath = path.join(tmp, 'push-subscriptions.json');
  makeBridgeFixture(bridgeRoot);

  const webPushMock = {
    setVapidDetails() {},
    sendNotification() {
      return Promise.resolve();
    },
  };
  const server = createOpsConsoleServer({
    queryReadonly,
    buildSessionSnapshot,
    skipLaunchctl: true,
    bridgeRoot,
    pushSubscriptionPath,
    vapidPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    vapidPrivateKey: 'private-smoke-key',
    vapidSubject: 'mailto:ops-console-smoke@localhost',
    webPush: webPushMock,
    port: 0,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const vapid = await (await fetch(`${base}/api/push/vapid-public`)).json();
    assert.equal(vapid.ok, true);
    assert.equal(vapid.configured, true);
    assert.equal(Boolean(vapid.publicKey), true);

    const subscriptionResponse = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.test/smoke',
        keys: { p256dh: 'p256dh-smoke', auth: 'auth-smoke' },
      }),
    });
    const subscription = await subscriptionResponse.json();
    assert.equal(subscription.ok, true);
    assert.equal(fs.existsSync(pushSubscriptionPath), true);
    assert.equal(JSON.parse(fs.readFileSync(pushSubscriptionPath, 'utf8')).subscriptions.length, 1);

    const bridge = await (await fetch(`${base}/api/bridge`)).json();
    assert.equal(bridge.ok, true);
    assert.equal(bridge.readOnly, true);
    assert.equal(bridge.counts.total, 2);
    assert.equal(bridge.items.some((item) => item.id === 'TASK-0003' && item.status === 'pending'), true);
    assert.equal(bridge.items.some((item) => item.id === 'TASK-0002' && item.verdict === 'verified'), true);

    const cryptoCritical = classifyOpsPushEvent({ team: 'luna', event_type: 'guard_liquidation', message: 'Binance loss limit liquidation guard' });
    const publishNormal = classifyOpsPushEvent({ team: 'blog', event_type: 'publish_report', message: 'normal publish completed' });
    assert.equal(cryptoCritical.shouldPush, true);
    assert.equal(cryptoCritical.level, 'critical');
    assert.equal(publishNormal.shouldPush, false);

    const overview = await (await fetch(`${base}/api/overview`)).json();
    const town = await (await fetch(`${base}/api/townsquare?limit=5`)).json();
    assert.equal(overview.ok, true);
    assert.equal(Array.isArray(overview.teams), true);
    assert.equal(town.ok, true);
    assert.equal(Array.isArray(town.events), true);

    console.log(JSON.stringify({
      ok: true,
      vapid: { configured: vapid.configured, publicKeyLength: vapid.publicKey.length },
      subscribe: { count: subscription.count, path: pushSubscriptionPath },
      bridge: { counts: bridge.counts, sample: bridge.items.slice(0, 2) },
      pushRouter: { cryptoCritical, publishNormal },
      regression: { teams: overview.teams.length, townEvents: town.events.length },
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
