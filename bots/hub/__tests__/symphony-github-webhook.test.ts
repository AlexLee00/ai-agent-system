'use strict';

/**
 * GitHub Issues Webhook 핸들러 단위 테스트
 *
 * 실행: node bots/hub/__tests__/symphony-github-webhook.test.ts
 */

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const HANDLER_PATH = path.resolve(__dirname, '../lib/webhooks/github-issues.ts');
const ROUTE_PATH = path.resolve(__dirname, '../lib/routes/github-webhook.ts');

function makeInsertedRows() {
  return [];
}

function makePgPoolStub(rows = []) {
  const db = rows;
  return {
    get: async (schema, sql, params) => {
      if (/SELECT id FROM symphony_tasks WHERE source_ref/.test(sql)) {
        return db.find((r) => r.source_ref === params[0] && r.source === params[1]) || null;
      }
      if (/SELECT id, status FROM symphony_tasks WHERE source_ref/.test(sql)) {
        return db.find((r) => r.source_ref === params[0] && r.source === params[1]) || null;
      }
      if (/SELECT id, target_team FROM symphony_tasks WHERE source_ref/.test(sql)) {
        return db.find((r) => r.source_ref === params[0] && r.source === params[1]) || null;
      }
      return null;
    },
    run: async (schema, sql, params) => {
      if (/INSERT INTO symphony_tasks/.test(sql)) {
        db.push({ id: params[0], source: params[1], target_team: params[2], source_ref: params[7], status: 'todo' });
      }
      if (/UPDATE symphony_tasks SET status/.test(sql)) {
        const task = db.find((r) => r.id === params[1]);
        if (task) task.status = params[0];
      }
    },
  };
}

async function withHandlerMocks(pgPool, fn) {
  const mocks = {
    '../../../../packages/core/lib/pg-pool': pgPool,
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[HANDLER_PATH];
    return await fn(require(HANDLER_PATH));
  } finally {
    Module._load = original;
    delete require.cache[HANDLER_PATH];
  }
}

// ─── verifyGithubSignature (순수 함수 — 모킹 불필요) ─────────────────────────

async function test_verifyGithubSignature_valid_hmac() {
  delete require.cache[HANDLER_PATH];
  const { verifyGithubSignature } = require(HANDLER_PATH);
  const secret = 'test-webhook-secret';
  const payload = Buffer.from(JSON.stringify({ action: 'opened' }));
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  try {
    assert.ok(verifyGithubSignature(payload, sig), 'valid HMAC should pass');
  } finally {
    if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    delete require.cache[HANDLER_PATH];
  }
  console.log('✅ verifyGithubSignature: valid HMAC passes');
}

async function test_verifyGithubSignature_invalid_hmac() {
  delete require.cache[HANDLER_PATH];
  const { verifyGithubSignature } = require(HANDLER_PATH);
  const payload = Buffer.from('{}');
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = 'real-secret';
  try {
    assert.strictEqual(
      verifyGithubSignature(payload, 'sha256=badhash'),
      false,
      'invalid HMAC should fail',
    );
  } finally {
    if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    delete require.cache[HANDLER_PATH];
  }
  console.log('✅ verifyGithubSignature: invalid HMAC rejected');
}

async function test_verifyGithubSignature_no_secret_always_passes() {
  delete require.cache[HANDLER_PATH];
  const { verifyGithubSignature } = require(HANDLER_PATH);
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    assert.ok(verifyGithubSignature(Buffer.from('{}'), undefined), 'no secret → always pass');
    assert.ok(verifyGithubSignature(Buffer.from('{}'), 'anything'), 'no secret → always pass with any sig');
  } finally {
    if (originalSecret !== undefined) process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    delete require.cache[HANDLER_PATH];
  }
  console.log('✅ verifyGithubSignature: no GITHUB_WEBHOOK_SECRET → always passes');
}

async function test_verifyGithubSignature_missing_signature_fails_when_secret_set() {
  delete require.cache[HANDLER_PATH];
  const { verifyGithubSignature } = require(HANDLER_PATH);
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = 'some-secret';
  try {
    assert.strictEqual(
      verifyGithubSignature(Buffer.from('{}'), undefined),
      false,
      'missing sig with secret set → fail',
    );
  } finally {
    if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    delete require.cache[HANDLER_PATH];
  }
  console.log('✅ verifyGithubSignature: missing sig fails when secret is set');
}

// ─── handleIssueOpened ───────────────────────────────────────────────────────

async function test_handleIssueOpened_inserts_symphony_task() {
  const db = [];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueOpened }) => {
    const issue = {
      number: 42,
      title: 'Fix trading signal bug',
      body: 'Description here',
      html_url: 'https://github.com/owner/repo/issues/42',
      labels: [{ name: 'symphony-task' }, { name: 'team:luna' }, { name: 'priority:high' }],
      user: { login: 'testuser' },
    };
    await handleIssueOpened(issue, 'owner/repo');
    assert.strictEqual(db.length, 1, 'one task inserted');
    assert.strictEqual(db[0].target_team, 'luna', 'luna team');
    assert.strictEqual(db[0].source_ref, '42', 'source_ref = issue number');
    assert.strictEqual(db[0].source, 'github');
  });
  console.log('✅ handleIssueOpened: inserts symphony task with team=luna');
}

async function test_handleIssueOpened_skips_non_symphony_issues() {
  const db = [];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueOpened }) => {
    const issue = {
      number: 10,
      title: 'Regular issue',
      body: null,
      html_url: 'https://github.com/owner/repo/issues/10',
      labels: [{ name: 'bug' }],
      user: { login: 'user' },
    };
    await handleIssueOpened(issue, 'owner/repo');
    assert.strictEqual(db.length, 0, 'no task for non-symphony issue');
  });
  console.log('✅ handleIssueOpened: skips issue without symphony-task label');
}

async function test_handleIssueOpened_skips_duplicate() {
  const existingTask = { id: 'task_existing', source: 'github', source_ref: '42', status: 'todo', target_team: 'claude' };
  const db = [existingTask];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueOpened }) => {
    const issue = {
      number: 42,
      title: 'Duplicate',
      body: '',
      html_url: 'https://github.com/owner/repo/issues/42',
      labels: [{ name: 'symphony-task' }],
      user: { login: 'user' },
    };
    await handleIssueOpened(issue, 'owner/repo');
    assert.strictEqual(db.length, 1, 'no duplicate task inserted');
  });
  console.log('✅ handleIssueOpened: skips duplicate task');
}

async function test_handleIssueOpened_defaults_to_claude_team() {
  const db = [];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueOpened }) => {
    const issue = {
      number: 99,
      title: 'Symphony task without team label',
      body: '',
      html_url: 'https://github.com/owner/repo/issues/99',
      labels: [{ name: 'symphony-task' }],
      user: { login: 'user' },
    };
    await handleIssueOpened(issue, 'owner/repo');
    assert.strictEqual(db[0].target_team, 'claude', 'defaults to claude');
  });
  console.log('✅ handleIssueOpened: defaults to claude team when no team label');
}

// ─── handleIssueClosed ───────────────────────────────────────────────────────

async function test_handleIssueClosed_marks_task_done() {
  const db = [{ id: 'task_1', source: 'github', source_ref: '5', status: 'in_progress', target_team: 'claude' }];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueClosed }) => {
    await handleIssueClosed({ number: 5, labels: [] });
    assert.strictEqual(db[0].status, 'done', 'task status → done');
  });
  console.log('✅ handleIssueClosed: marks task as done');
}

async function test_handleIssueClosed_skips_already_done() {
  const db = [{ id: 'task_done', source: 'github', source_ref: '7', status: 'done', target_team: 'claude' }];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueClosed }) => {
    await handleIssueClosed({ number: 7 });
    assert.strictEqual(db[0].status, 'done', 'already done, no double-update');
  });
  console.log('✅ handleIssueClosed: skips already-done task');
}

async function test_handleIssueClosed_skips_unknown_issue() {
  const db = [];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueClosed }) => {
    await handleIssueClosed({ number: 999 });
    assert.strictEqual(db.length, 0, 'no-op for unknown issue');
  });
  console.log('✅ handleIssueClosed: skips unknown issue');
}

// ─── handleIssueReopened ─────────────────────────────────────────────────────

async function test_handleIssueReopened_marks_task_todo() {
  const db = [{ id: 'task_r', source: 'github', source_ref: '8', status: 'done', target_team: 'claude' }];
  const pgPool = makePgPoolStub(db);
  await withHandlerMocks(pgPool, async ({ handleIssueReopened }) => {
    await handleIssueReopened({ number: 8, labels: [], title: 'Reopened', body: '', html_url: '', user: { login: 'u' } });
    assert.strictEqual(db[0].status, 'todo', 'reopened → status todo');
  });
  console.log('✅ handleIssueReopened: marks task as todo');
}

// ─── 실행 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Symphony GitHub Webhook 테스트 시작 ===\n');
  const tests = [
    test_verifyGithubSignature_valid_hmac,
    test_verifyGithubSignature_invalid_hmac,
    test_verifyGithubSignature_no_secret_always_passes,
    test_verifyGithubSignature_missing_signature_fails_when_secret_set,
    test_handleIssueOpened_inserts_symphony_task,
    test_handleIssueOpened_skips_non_symphony_issues,
    test_handleIssueOpened_skips_duplicate,
    test_handleIssueOpened_defaults_to_claude_team,
    test_handleIssueClosed_marks_task_done,
    test_handleIssueClosed_skips_already_done,
    test_handleIssueClosed_skips_unknown_issue,
    test_handleIssueReopened_marks_task_todo,
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (e) {
      console.error(`❌ ${t.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
