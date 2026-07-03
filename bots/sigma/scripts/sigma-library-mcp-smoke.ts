#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SIGMA_LIBRARY_MCP_TOOLS,
  callSigmaLibraryTool,
  createSigmaLibraryMcpServer,
  startServer,
} from '../mcp/sigma-library-mcp/src/server.ts';

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function mockDeps() {
  const calls = [];
  return {
    calls,
    embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
    queryReadonly: async (schema, sql, params = []) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'sigma');
      assert.match(String(sql).trim(), /^SELECT/i);
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
      return [
        {
          id: 'pred-1',
          title: 'Luna forward view',
          source: 'luna',
          file_path: 'library/luna/pred.md',
          meta: { team: 'luna', libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'validated', prediction_state: 'forward' } },
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
  }, deps);
  assert.equal(search.ok, true);
  assert.equal(search.mode, 'read_only_search');
  assert.equal(search.routing.intent, 'prediction');

  const predictions = await callSigmaLibraryTool('library-predictions', { limit: 10 }, deps);
  assert.equal(predictions.ok, true);
  assert.equal(predictions.predictions.length, 1);
  assert.equal(predictions.accuracy[0].team, 'luna');
  assert.equal(predictions.accuracy[0].accuracy, 1);

  const coords = await callSigmaLibraryTool('library-coords', { limit: 10 }, deps);
  assert.equal(coords.ok, true);
  assert.equal(coords.rows[0].count, 2);
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

async function main() {
  await assertDirectTools();
  await assertRpcServer();
  console.log(JSON.stringify({ ok: true, smoke: 'sigma-library-mcp', tools: SIGMA_LIBRARY_MCP_TOOLS.map((tool) => tool.name) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
