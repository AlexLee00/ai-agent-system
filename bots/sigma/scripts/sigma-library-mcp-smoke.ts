#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SIGMA_LIBRARY_MCP_TOOLS,
  callSigmaLibraryTool,
  createSigmaLibraryMcpServer,
  installShutdownHandlers,
  startServer,
} from '../mcp/sigma-library-mcp/src/server.ts';

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function mockDeps({ aggregateRows = null, aggregateError = false } = {}) {
  const calls = [];
  return {
    calls,
    embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
    queryReadonly: async (schema, sql, params = []) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'sigma');
      assert.match(String(sql).trim(), /^(SELECT|WITH)\b/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE)\b/i.test(sql), false);
      if (String(sql).includes('information_schema.columns')) {
        return [
          { column_name: 'abstraction_level' },
          { column_name: 'time_stage' },
          { column_name: 'validation_state' },
          { column_name: 'prediction_state' },
          { column_name: 'prediction_horizon' },
        ];
      }
      if (String(sql).includes('GROUP BY 1, 2, 3, 4')) {
        return [{
          abstraction_level: 'L0',
          time_stage: 'raw',
          validation_state: 'observed',
          prediction_state: 'forward',
          count: 2,
        }];
      }
      if (String(sql).includes('AS validated') && String(sql).includes('AS contradicted')) {
        if (aggregateError) throw new Error('aggregate unavailable');
        return aggregateRows || [{ team: 'luna', total: 7, validated: 4, contradicted: 1, resolved: 6, accuracy_samples: 5 }];
      }
      return [
        {
          id: 'pred-1',
          title: 'Luna forward view',
          source: 'luna',
          file_path: 'library/luna/pred.md',
          meta: {
            team: 'blog',
            source_ref: { team: 'luna', table: 'investment.trade_journal', id: 'TRD-1' },
            libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'validated', prediction_state: 'forward' },
          },
          created_at: '2026-07-03T00:00:00.000Z',
          abstraction_level: 'L0',
          time_stage: 'raw',
          validation_state: 'validated',
          prediction_state: 'forward',
          prediction_horizon: '2026-07-10T00:00:00.000Z',
          content_preview: 'forward',
          similarity: 0.9,
        },
      ];
    },
  };
}

async function assertDirectTools() {
  const toolNames = SIGMA_LIBRARY_MCP_TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['library-coords', 'library-predictions', 'library-search', 'library-wiki'].sort());
  for (const tool of SIGMA_LIBRARY_MCP_TOOLS) {
    assert.equal(/write|delete|apply|restart|kill/i.test(`${tool.name} ${tool.description}`), false);
  }

  const deps = mockDeps();
  const search = await callSigmaLibraryTool('library-search', {
    query: '다음 주 전망',
    layerSearchEnabled: true,
    teamNamespaces: ['luna'],
    coordFilters: { validation_state: ['validated'] },
    strictLayerFilters: true,
    groupBySourceRef: true,
  }, deps);
  assert.equal(search.ok, true);
  assert.equal(search.mode, 'read_only_search');
  assert.equal(search.routing.intent, 'prediction');
  const searchCall = deps.calls.find((call) => /FROM sigma\.vault_entries/.test(call.sql));
  assert.match(searchCall.sql, /meta->>'team'/);
  assert.match(searchCall.sql, /meta->'source_refs'/);
  assert.match(searchCall.sql, /COALESCE\(status, 'captured'\) <> 'archived'/);
  assert.match(searchCall.sql, /validation_state/);
  assert.match(searchCall.sql, /ROW_NUMBER\(\) OVER/);
  assert.match(searchCall.sql, /meta->'source_ref'->>'team'/);
  assert.match(searchCall.sql, /meta->'source_ref'->>'table'/);
  assert.match(searchCall.sql, /meta->'source_ref'->>'id'/);
  assert.equal(searchCall.params.some((param) => Array.isArray(param) && param.includes('luna')), true);
  assert.equal(searchCall.params.some((param) => Array.isArray(param) && param.includes('validated')), true);

  const predictions = await callSigmaLibraryTool('library-predictions', { limit: 10 }, deps);
  assert.equal(predictions.ok, true);
  assert.equal(predictions.predictions.length, 1);
  assert.equal(predictions.predictions[0].team, 'luna');
  assert.equal(predictions.accuracy[0].team, 'luna');
  assert.equal(predictions.accuracy[0].total, 7);
  assert.equal(predictions.accuracy[0].resolved, 6);
  assert.equal(predictions.accuracy[0].accuracySamples, 5);
  assert.equal(predictions.accuracy[0].hits, 4);
  assert.equal(predictions.accuracy[0].misses, 1);
  assert.equal(predictions.accuracy[0].accuracy, 0.8);
  assert.deepEqual(predictions.accuracyStatus, {
    skipped: false,
    reason: null,
    source: 'full_aggregate',
  });
  const accuracyCall = deps.calls.find((call) => /AS validated/.test(call.sql));
  assert.equal(Boolean(accuracyCall), true);
  assert.doesNotMatch(accuracyCall.sql, /LIMIT \$1/);
  assert.match(accuracyCall.sql, /prediction_outcome/);
  assert.match(accuracyCall.sql, /= 'resolved'/);
  assert.ok(accuracyCall.sql.indexOf("meta->'source_ref'->>'team'") < accuracyCall.sql.indexOf("meta->>'team'"));
  const predictionDetailCall = deps.calls.find((call) => /ORDER BY created_at DESC\s+LIMIT \$1/.test(call.sql));
  assert.match(predictionDetailCall.sql, /COALESCE\(status, 'captured'\) <> 'archived'/);

  const unresolvedDeps = mockDeps({
    aggregateRows: [{ team: 'luna', total: 5, validated: 0, contradicted: 0, resolved: 0, accuracy_samples: 0 }],
  });
  const unresolved = await callSigmaLibraryTool('library-predictions', { limit: 10 }, unresolvedDeps);
  assert.equal(unresolved.predictions[0].coords.validation_state, 'validated');
  assert.equal(unresolved.predictions[0].coords.prediction_state, 'forward');
  assert.equal(unresolved.accuracy[0].accuracySamples, 0);
  assert.equal(unresolved.accuracy[0].accuracy, null);

  const aggregateFailureDeps = mockDeps({ aggregateError: true });
  const aggregateFailure = await callSigmaLibraryTool('library-predictions', { limit: 1 }, aggregateFailureDeps);
  assert.equal(aggregateFailure.predictions.length, 1);
  assert.deepEqual(aggregateFailure.accuracy, []);
  assert.deepEqual(aggregateFailure.accuracyStatus, {
    skipped: true,
    reason: 'prediction_aggregate_query_failed',
    source: null,
  });

  const coords = await callSigmaLibraryTool('library-coords', { limit: 10 }, deps);
  assert.equal(coords.ok, true);
  assert.equal(coords.rows[0].count, 2);
  const coordCall = deps.calls.find((call) => /GROUP BY 1, 2, 3, 4/.test(call.sql));
  assert.match(coordCall.sql, /COALESCE\(status, 'captured'\) <> 'archived'/);
  assert.ok(deps.calls.length >= 4);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-library-mcp-'));
  fs.writeFileSync(path.join(tmp, 'luna.md'), '# luna\n\nSource: `vault-entry:1`\n', 'utf8');
  const ignoredOverride = await callSigmaLibraryTool('library-wiki', { wikiDir: tmp, topic: 'luna' });
  assert.equal(ignoredOverride.ok, false);
  const listed = await callSigmaLibraryTool('library-wiki', {}, { wikiDir: tmp });
  assert.equal(listed.ok, true);
  assert.equal(listed.pages[0].topic, 'luna');
  const page = await callSigmaLibraryTool('library-wiki', { topic: 'luna' }, { wikiDir: tmp });
  assert.equal(page.ok, true);
  assert.match(page.content, /vault-entry:1/);
}

async function assertRpcServer() {
  const server = createSigmaLibraryMcpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const listed = await postJson(`${base}/rpc`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.tools.length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const started = await startServer({ port: 0 });
  try {
    const health = await fetch(`http://${started.host}:${started.port}/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'sigma-library-mcp');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

function assertShutdownHandlers() {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  let closeCalls = 0;
  let closeIdleCalls = 0;
  const server = {
    close(callback) {
      closeCalls += 1;
      callback();
    },
    closeIdleConnections() {
      closeIdleCalls += 1;
    },
  };

  installShutdownHandlers(server, { processRef, timeoutMs: 100 });
  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  assert.equal(closeCalls, 1);
  assert.equal(closeIdleCalls, 1);
  assert.deepEqual(exits, [0]);
}

async function main() {
  await assertDirectTools();
  await assertRpcServer();
  assertShutdownHandlers();
  console.log(JSON.stringify({ ok: true, smoke: 'sigma-library-mcp', tools: SIGMA_LIBRARY_MCP_TOOLS.map((tool) => tool.name) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
