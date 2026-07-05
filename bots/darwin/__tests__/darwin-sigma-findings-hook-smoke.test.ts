'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('../lib/sigma-findings-hook.ts');

function response(body: Record<string, unknown>, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-sigma-hook-'));
  const queuePath = path.join(tmp, 'queue.jsonl');
  try {
    const queued = await hook.contributeSigmaFinding(
      { id: 'p1', title: 'Finding P1', status: 'archived' },
      'archived',
      { reason: 'triage_stale' },
      {
        queuePath,
        fetchFn: async () => response({ result: { tools: [{ name: 'library-search' }] } }),
      },
    );
    assert.strictEqual(queued.queued, true);
    assert.strictEqual(fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).length, 1);

    let calledTool = '';
    const contributed = await hook.contributeSigmaFinding(
      { id: 'p2', title: 'Finding P2', status: 'adopted' },
      'adopted',
      { pr_url: 'https://example.invalid/pr/2' },
      {
        queuePath,
        fetchFn: async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body || '{}'));
          if (body.method === 'tools/list') {
            return response({ result: { tools: [{ name: 'library-contribute-finding' }] } });
          }
          calledTool = body.params?.name;
          return response({ result: { ok: true } });
        },
      },
    );
    assert.strictEqual(contributed.ok, true);
    assert.strictEqual(contributed.queued, false);
    assert.strictEqual(calledTool, 'library-contribute-finding');
    console.log('✅ darwin sigma findings hook smoke ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
