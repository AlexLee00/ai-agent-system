// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  SKA_OPS_MCP_TOOLS,
  callSkaOpsTool,
  startServer,
} = require('../mcp/ska-ops-mcp/src/server.ts');

function createQueryReadonlyMock() {
  const calls = [];
  const reservations = [
    { id: 1, date: '2026-07-03', start_time: '10:00', end_time: '11:00', room: 'A1', status: 'completed', pickko_status: null, updated_at: '2026-07-03T02:00:00.000Z' },
    { id: 2, date: '2026-07-03', start_time: '11:00', end_time: '12:00', room: 'A2', status: 'completed', pickko_status: 'paid', updated_at: '2026-07-03T02:00:00.000Z' },
    { id: 3, date: '2026-07-03', start_time: '12:00', end_time: '13:00', room: 'B', status: 'cancelled', pickko_status: null, updated_at: '2026-07-03T02:00:00.000Z' },
  ];
  const pickkoRows = [
    { entry_key: 'pk-a2', use_date: '2026-07-03', use_start_time: '11:00', use_end_time: '12:00', room_type: 'A2', order_kind: 'booking', raw_amount: 10000 },
    { entry_key: 'pk-b', use_date: '2026-07-03', use_start_time: '12:00', use_end_time: '13:00', room_type: 'B', order_kind: 'booking', raw_amount: 10000 },
    { entry_key: 'pk-only', use_date: '2026-07-03', use_start_time: '14:00', use_end_time: '15:00', room_type: 'A1', order_kind: 'booking', raw_amount: 12000 },
  ];
  return {
    calls,
    pickkoRows,
    async queryReadonly(schema, sql, params = []) {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'reservation');
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql), false, `write SQL not allowed: ${sql}`);
      if (/FROM schema_migrations/i.test(sql)) {
        return [{ version: 14, name: 'cancel_retry_queue' }];
      }
      if (/FROM cancel_retry_queue/i.test(sql) && /GROUP BY status/i.test(sql)) {
        return [{ status: 'pending', count: 2 }, { status: 'manual_required', count: 1 }];
      }
      if (/FROM cancel_retry_queue/i.test(sql) && /GROUP BY reason/i.test(sql)) {
        return [{ reason: 'timeout', status: 'pending', count: 2 }];
      }
      if (/FROM reservations/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
        return [{ count: 1 }];
      }
      if (/FROM reservations/i.test(sql)) {
        assert.match(sql, /NULLIF\(BTRIM\(date::text\), ''\) IS NOT NULL/);
        assert.match(sql, /BTRIM\(date::text\) ~/);
        assert.match(sql, /BTRIM\(date::text\) BETWEEN \$1 AND \$2/);
        return reservations;
      }
      assert.equal(/FROM pickko_order_raw/i.test(sql), false);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function postJson({ port, path = '/rpc', body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function getJson({ port, path = '/health' }) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const plist = fs.readFileSync(path.join(__dirname, '../launchd/ai.ska.ops-mcp.plist'), 'utf8');
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /mcp\/ska-ops-mcp\/src\/server\.ts/);
  assert.equal(plist.includes('/bin/bash'), false);
  assert.equal(plist.includes('npm --prefix'), false);

  assert.deepStrictEqual(
    SKA_OPS_MCP_TOOLS.map((tool) => tool.name),
    ['cancel-pipeline-status', 'reservation-sync-check'],
  );

  const mock = createQueryReadonlyMock();
  const deps = {
    queryReadonly: mock.queryReadonly,
    readPickkoSnapshot: () => ({
      version: 1,
      collectedAt: '2026-07-03T03:00:00.000Z',
      coverage: { from: '2026-07-03', to: '2026-07-03', complete: true },
      fetchOk: true,
      entryCount: mock.pickkoRows.length,
      entries: mock.pickkoRows.map((row) => ({
        date: row.use_date,
        start: row.use_start_time,
        end: row.use_end_time,
        room: row.room_type,
        status: 'paid',
      })),
    }),
    nowMs: Date.parse('2026-07-03T04:00:00.000Z'),
  };

  const pipeline = await callSkaOpsTool('cancel-pipeline-status', {}, deps);
  assert.equal(pipeline.mode, 'read_only');
  assert.equal(pipeline.migration.version, 14);
  assert.equal(pipeline.retryQueue.byStatus[0].status, 'pending');
  assert.equal(Object.prototype.hasOwnProperty.call(pipeline, 'shadow'), false);

  const sync = await callSkaOpsTool('reservation-sync-check', { date: '2026-07-03' }, deps);
  assert.equal(sync.mode, 'read_only_advisory');
  assert.equal(sync.counts.naverCompletedMissingPickko, 1);
  assert.equal(sync.counts.cancelledButPickkoEvidence, 1);
  assert.equal(sync.counts.pickkoOnly, 1);
  assert.equal(sync.counts.invalidReservationDates, 1);
  assert.equal(sync.hygiene.invalidReservationDatePolicy, 'excluded_from_sync_check');
  assert.equal(Object.prototype.hasOwnProperty.call(sync.naverCompletedMissingPickko[0], 'phone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sync.pickkoOnly[0], 'entryKey'), false);
  assert.match(sync.pickkoOnly[0].entryRef, /^[0-9a-f]{12}$/);
  assert.equal(sync.cancelledButPickkoEvidence[0].pickkoEvidence[0].entryRef.includes('pk-b'), false);

  const { server, port } = await startServer({ port: 0, deps });
  try {
    const health = await getJson({ port });
    assert.equal(health.status, 200);
    assert.equal(health.body.service, 'ska-ops-mcp');

    const list = await postJson({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(list.status, 200);
    assert.equal(list.body.result.tools.length, 2);

    for (const name of ['cancel-pipeline-status', 'reservation-sync-check']) {
      const response = await postJson({
        port,
        body: { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: { date: '2026-07-03' } } },
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.result.content[0].type, 'json');
      assert.equal(response.body.result.content[0].json.ok, true);
    }
  } finally {
    server.close();
  }

  console.log(JSON.stringify({
    ok: true,
    tests: ['tools', 'pipeline-status', 'reservation-sync-check', 'http-json-rpc', 'read-only-sql', 'direct-launchd-supervision'],
    queryCalls: mock.calls.length,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
