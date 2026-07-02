#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiOsDashboardServer } from '../services/ai-os-dashboard/server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function readSseOnce(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/os/stream`, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n\n')) {
          req.destroy();
          resolve(buffer);
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('sse_timeout'));
    });
    req.on('error', reject);
  });
}

async function main() {
  const fixture = {
    ok: true,
    generatedAt: '2026-07-02T00:00:00.000Z',
    readOnly: true,
    parts: {
      agentRegistry: { ok: true, data: { total: 2 } },
      launchd: { ok: true, data: { total: 1 } },
      hubKernel: { ok: true, data: {} },
      llmCost: { ok: true, data: { calls24h: 3 } },
      hubAlarms: { ok: true, data: { rows: [] } },
      traceTimeline: { ok: true, data: { skipped: true } },
    },
  };

  const disabled = createAiOsDashboardServer({ enabledFn: () => false, collectSnapshot: async () => fixture });
  const disabledBase = await listen(disabled);
  assert.equal((await getJson(disabledBase, '/health')).body.enabled, false);
  assert.equal((await getJson(disabledBase, '/api/os/snapshot')).status, 404);
  await new Promise((resolve) => disabled.close(resolve));

  const enabled = createAiOsDashboardServer({ enabledFn: () => true, collectSnapshot: async () => fixture });
  enabled.pushSnapshot(fixture);
  const enabledBase = await listen(enabled);
  const snapshot = await getJson(enabledBase, '/api/os/snapshot');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.readOnly, true);
  const sse = await readSseOnce(enabledBase);
  assert.match(sse, /event: hello|event: snapshot/);
  await new Promise((resolve) => enabled.close(resolve));

  const web = fs.readFileSync(path.join(__dirname, '../services/ai-os-dashboard/web/app.js'), 'utf8');
  assert.match(web, /EventSource/);
  assert.match(web, /api\/os\/snapshot/);

  const serverSource = fs.readFileSync(path.join(__dirname, '../services/ai-os-dashboard/server.ts'), 'utf8');
  assert.doesNotMatch(serverSource, /pgPool\.run|launchctl.+bootout|launchctl.+bootstrap|INSERT\s+INTO|UPDATE\s+.+SET|DELETE\s+FROM/i);

  console.log(JSON.stringify({ ok: true, checks: 7 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
