'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const serverModule = require('../mcp/darwin-ops-mcp/src/server.ts');

function requestJson(url: string): Promise<{ status?: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res: import('http').IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-ops-mcp-'));
  const learningsPath = path.join(tmp, 'learnings.md');
  fs.writeFileSync(learningsPath, '2026-07-05 | proposal=p1 | reason=fixture\n', 'utf8');
  const proposals = [
    { id: 'p1', title: 'P1', status: 'measured', branch: 'darwin/p1', changed_files: ['bots/darwin/x.ts'], measurement: { predicate_results: [{ ok: true }] } },
    { id: 'p2', title: 'P2', status: 'archived' },
  ];
  const deps = {
    proposalStore: {
      listProposals: () => proposals,
      normalizeProposalState: (status: unknown) => status === 'measured' ? 'measured' : status === 'archived' ? 'archived' : 'proposed',
    },
    adoptPipeline: {
      selectAdoptCandidates: () => ({
        cap: 2,
        candidates: [{ proposal: proposals[0], changedFiles: ['bots/darwin/x.ts'] }],
        blocked: [{ proposal: proposals[1], blockedReason: 'not_measured', denylistMatches: [] }],
      }),
    },
    telemetry: {
      tailTelemetry: () => [{ phase: 'fixture', event: 'end' }],
    },
    learningsPath,
  };

  try {
    assert.strictEqual(serverModule.DARWIN_OPS_TOOLS.length, 4);
    assert.strictEqual((await serverModule.callDarwinOpsTool('cycle_status', {}, deps)).proposalCount, 2);
    assert.strictEqual((await serverModule.callDarwinOpsTool('proposals', { state: 'measured' }, deps)).proposals.length, 1);
    assert.strictEqual((await serverModule.callDarwinOpsTool('adopt_queue', {}, deps)).candidates.length, 1);
    assert.strictEqual((await serverModule.callDarwinOpsTool('learnings_tail', { limit: 1 }, deps)).lines.length, 1);

    const server = serverModule.startServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const health = await requestJson(`http://127.0.0.1:${address.port}/health`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    await new Promise((resolve) => server.close(resolve));
    console.log('✅ darwin ops mcp smoke ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
