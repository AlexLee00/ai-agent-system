#!/usr/bin/env tsx
'use strict';

const assert = require('assert');

process.env.HUB_AUTH_TOKEN = process.env.HUB_AUTH_TOKEN || 'hub-runtime-autonomy-smoke-token';
process.env.HUB_JSON_LIMIT_MB = process.env.HUB_JSON_LIMIT_MB || '1';
process.env.HUB_EVENTS_JSON_LIMIT_MB = process.env.HUB_EVENTS_JSON_LIMIT_MB || '4';
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '6';
process.env.HUB_PG_ACTIVE_LIMIT = process.env.HUB_PG_ACTIVE_LIMIT || '6';
process.env.HUB_PG_WAITING_LIMIT = process.env.HUB_PG_WAITING_LIMIT || '5';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { createHubApp, routeClassForBodyLimit } = require('../src/app.ts');
const { shouldDeferPgQuery, resolvePgActiveLimit } = require('../lib/routes/pg.ts');
const { recordHubRuntimeErrorPattern } = require('../lib/autonomy/runtime-error-learning.ts');

async function withServer(app: any, fn: (baseUrl: string) => Promise<void>) {
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

async function main() {
  assert.equal(routeClassForBodyLimit('/hub/events/publish'), 'events');
  assert.equal(routeClassForBodyLimit('/hub/llm/call'), 'llm');
  assert.equal(routeClassForBodyLimit('/hub/alarm'), 'default');
  assert.equal(resolvePgActiveLimit(), 6);
  assert.deepEqual(shouldDeferPgQuery({ waiting: 0, active: 2, total: 2 }).defer, false);
  assert.equal(shouldDeferPgQuery({ waiting: 6, active: 2, total: 6 }).defer, true);
  assert.equal(shouldDeferPgQuery({ waiting: 0, active: 6, total: 6 }).defer, true);

  const app = createHubApp({
    isShuttingDown: () => false,
    isStartupComplete: () => true,
  });

  const largeText = 'x'.repeat(1200 * 1024);
  const targetDate = '2099-12-31';
  const smokeTitle = `hub-runtime-autonomy-smoke-${Date.now()}`;

  await withServer(app, async (baseUrl) => {
    const defaultResp = await fetch(`${baseUrl}/hub/alarm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: largeText, team: 'hub', fromBot: 'smoke' }),
    });
    const defaultBody = await defaultResp.json();
    assert.equal(defaultResp.status, 413);
    assert.equal(defaultBody.error, 'request_entity_too_large');
    assert.ok(defaultBody.traceId, '413 response should include traceId');

    const eventResp = await fetch(`${baseUrl}/hub/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'smoke', topic: 'hub.runtime_autonomy_smoke', payload: { largeText } }),
    });
    assert.equal(eventResp.status, 401, 'large events payload should pass parser and reach auth');

    const readonlyWriteResp = await fetch(`${baseUrl}/hub/pg/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schema: 'blog',
        sql: 'INSERT INTO blog.topic_candidates(title) VALUES($1)',
        params: ['should-not-write'],
      }),
    });
    const readonlyWriteBody = await readonlyWriteResp.json();
    assert.equal(readonlyWriteResp.status, 400);
    assert.match(String(readonlyWriteBody.reason || ''), /blocked keyword/i);

    const topicResp = await fetch(`${baseUrl}/hub/blog/topic-candidates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_date: targetDate,
        candidates: [{
          category: '최신IT트렌드',
          title: smokeTitle,
          question: '허브 typed mutation smoke',
          diff: 'read-only pg_query 우회 금지 검증',
          keywords: ['hub', 'smoke'],
          score: 0.9,
        }],
      }),
    });
    const topicBody = await topicResp.json();
    assert.equal(topicResp.status, 200);
    assert.equal(topicBody.ok, true);
    assert.equal(topicBody.saved_count, 1);

    const duplicateTopicResp = await fetch(`${baseUrl}/hub/blog/topic-candidates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_date: targetDate,
        candidates: [{
          category: '최신IT트렌드',
          title: smokeTitle,
          question: '중복 저장 smoke',
          diff: 'ON CONFLICT DO NOTHING rowCount 검증',
          keywords: ['hub', 'duplicate'],
          score: 0.8,
        }],
      }),
    });
    const duplicateTopicBody = await duplicateTopicResp.json();
    assert.equal(duplicateTopicResp.status, 200);
    assert.equal(duplicateTopicBody.ok, true);
    assert.equal(duplicateTopicBody.saved_count, 0, 'duplicate candidate should not be counted as saved');

    const concurrentTitle = `${smokeTitle}-concurrent`;
    const concurrentBody = JSON.stringify({
      target_date: targetDate,
      candidates: [{
        category: '최신IT트렌드',
        title: concurrentTitle,
        question: '동시 저장 smoke',
        diff: 'advisory lock 중복 방지 검증',
        keywords: ['hub', 'concurrency'],
        score: 0.8,
      }],
    });
    const concurrentRequests = [0, 1].map(() => fetch(`${baseUrl}/hub/blog/topic-candidates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: concurrentBody,
    }));
    const concurrentResponses = await Promise.all(concurrentRequests);
    const concurrentBodies = await Promise.all(concurrentResponses.map((response) => response.json()));
    assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
    assert.equal(
      concurrentBodies.reduce((sum, body) => sum + Number(body.saved_count || 0), 0),
      1,
      'concurrent duplicate candidates should insert exactly once',
    );
  });

  try {
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS count
      FROM blog.topic_candidates
      WHERE target_date = $1::date AND title LIKE $2
    `, [targetDate, `${smokeTitle}%`]);
    assert.equal(Number(rows[0]?.count || 0), 2);
  } finally {
    await pgPool.run('blog', `
      DELETE FROM blog.topic_candidates
      WHERE target_date = $1::date AND title LIKE $2
    `, [targetDate, `${smokeTitle}%`]).catch(() => null);
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  const suggestions = await pgPool.query('agent', `
    SELECT COUNT(*)::int AS count
    FROM agent.hub_runtime_tuning_suggestions
    WHERE error_type = 'request_entity_too_large'
      AND route = '/hub/alarm'
      AND route_class = 'default'
  `);
  assert.ok(Number(suggestions[0]?.count || 0) >= 1, '413 should be learned as a runtime tuning suggestion');

  const readonlyWriteSuggestions = await pgPool.query('agent', `
    SELECT COUNT(*)::int AS count
    FROM agent.hub_runtime_tuning_suggestions
    WHERE error_type = 'readonly_write_rejected'
      AND route = '/hub/pg/query'
      AND route_class = 'blog:write'
      AND suggested_value = '/hub/blog/topic-candidates'
  `);
  assert.ok(Number(readonlyWriteSuggestions[0]?.count || 0) >= 1, 'read-only write rejection should be learned with a typed-route suggestion');

  await recordHubRuntimeErrorPattern({
    errorType: 'pg_pool_overloaded',
    route: '/hub/pg/query',
    routeClass: 'blog:readonly',
    method: 'POST',
    status: 503,
    currentValue: 'active=6,waiting=6,active_limit=6,waiting_limit=5',
    suggestedValue: 'PG_POOL_MAX=12',
    rationale: 'Smoke verifies pg pool saturation feeds the Sigma runtime tuning loop.',
    traceId: 'hub-runtime-autonomy-smoke',
    evidence: { smoke: true },
  });
  const pgPoolSuggestions = await pgPool.query('agent', `
    SELECT COUNT(*)::int AS count
    FROM agent.hub_runtime_tuning_suggestions
    WHERE error_type = 'pg_pool_overloaded'
      AND route = '/hub/pg/query'
      AND route_class = 'blog:readonly'
  `);
  assert.ok(Number(pgPoolSuggestions[0]?.count || 0) >= 1, 'pg pool overload should be learned as a runtime tuning suggestion');

  console.log('hub_runtime_autonomy_smoke_ok');
}

main().catch((error: any) => {
  console.error('[hub-runtime-autonomy-smoke] failed:', error?.message || error);
  process.exit(1);
});
