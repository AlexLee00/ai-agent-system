'use strict';

/**
 * auto-dev-pipeline.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/auto-dev-pipeline.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PIPELINE_PATH = path.resolve(__dirname, '../lib/auto-dev-pipeline.ts');
const AUTO_DEV_PLIST_PATH = path.resolve(__dirname, '../launchd/ai.claude.auto-dev.plist');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auto-dev-'));
}

function makeDoc(tmpRoot, fileName = 'CODEX_SAMPLE.md', content = '# A\nx') {
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const filePath = path.join(autoDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeMocks(tmpRoot, overrides = {}) {
  const alarms = [];
  const childProcessMock = {
    execFileSync: (command) => {
      if (command === 'bash') return '/usr/local/bin/claude\n';
      if (command === 'claude') return 'ok';
      if (command === 'rg') throw new Error('no match');
      return '';
    },
    execSync: () => '',
  };

  return {
    alarms,
    mocks: {
      '../../../packages/core/lib/env': { PROJECT_ROOT: tmpRoot },
      '../../../packages/core/lib/openclaw-client': {
        postAlarm: async payload => {
          alarms.push(payload);
          return { ok: true };
        },
      },
      './team-bus': {
        setStatus: async () => {},
        markDone: async () => {},
        markError: async () => {},
      },
      '../src/reviewer': {
        runReview: async () => ({ summary: { pass: true }, message: 'review ok' }),
      },
      '../src/guardian': {
        runFullSecurityScan: async () => ({ pass: true, message: 'guardian ok', critical: [], high: [] }),
      },
      '../src/builder': {
        runBuildCheck: async () => ({ pass: true, message: 'build ok', results: [] }),
      },
      child_process: childProcessMock,
      fs: require('fs'),
      path: require('path'),
      os: require('os'),
      crypto: require('crypto'),
      ...overrides,
    },
  };
}

async function withMocks(mocks, fn, env = {}) {
  const original = Module._load;
  const originalEnv = {};

  for (const [key, value] of Object.entries(env)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[PIPELINE_PATH];
    return await fn(require(PIPELINE_PATH));
  } finally {
    Module._load = original;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    delete require.cache[PIPELINE_PATH];
  }
}

function testEnv(tmpRoot, extra = {}) {
  return {
    CLAUDE_AUTO_DEV_STATE_FILE: path.join(tmpRoot, 'auto-dev-state.json'),
    CLAUDE_AUTO_DEV_RUN_HARD_TESTS: 'false',
    ...extra,
  };
}

async function test_stages_define_required_lifecycle() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const ids = pipeline.STAGES.map(stage => stage.id);
    assert.deepStrictEqual(ids, [
      'received',
      'analysis',
      'plan',
      'implementation',
      'review',
      'revise_after_review',
      'test',
      'revise_after_test',
      'completed',
    ]);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: lifecycle stages are defined');
}

async function test_listAutoDevDocuments_uses_auto_dev_only() {
  const tmpRoot = makeTempRoot();
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'auto_dev'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'auto_dev', 'CODEX_SAMPLE.md'), '# A', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'codex', 'CODEX_OLD.md'), '# B', 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, ['docs/auto_dev/CODEX_SAMPLE.md']);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: scans docs/auto_dev only');
}

async function test_analyzeAutoDevDocument_extracts_code_refs() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'bots', 'claude', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'bots', 'claude', 'src', 'reviewer.ts'), 'export {}', 'utf8');
  const doc = path.join(autoDir, 'CODEX_SAMPLE.md');
  fs.writeFileSync(doc, '# Sample\n\n수정 파일: `bots/claude/src/reviewer.ts`', 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const analysis = pipeline.analyzeAutoDevDocument(doc);
    assert.strictEqual(analysis.title, 'Sample');
    assert.ok(analysis.codeRefs.includes('bots/claude/src/reviewer.ts'));
    assert.ok(analysis.relatedFiles.includes('bots/claude/src/reviewer.ts'));
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: analyzes document and related code refs');
}

async function test_processAutoDevDocument_runs_full_dry_pipeline() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_SAMPLE.md', '# A\nx');
  const { mocks, alarms } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      shadow: false,
      force: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.job.status, 'completed');
    assert.strictEqual(result.job.stage, 'completed');
    assert.ok(Array.isArray(result.job.beforeStatus));
    assert.ok(Array.isArray(result.job.afterStatus));
    assert.ok(Array.isArray(result.job.newlyChangedFiles));
  }, testEnv(tmpRoot));

  assert.strictEqual(alarms.length, 0, 'test 모드는 실제 알림 대신 shadow');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: processes dry pipeline to completion');
}

async function test_completed_job_is_skipped_without_force() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_SKIP.md', '# A\nx');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const first = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(first.ok, true);
    const second = await pipeline.processAutoDevDocument(doc, { test: true, force: false });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.reason, 'already_completed');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed job is skipped when force=false');
}

async function test_content_hash_job_id_prevents_touch_reprocessing() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_TOUCH.md', '# A\nx');
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const first = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(first.ok, true);
    const firstId = first.job.id;

    const now = new Date();
    fs.utimesSync(doc, now, new Date(now.getTime() + 60_000));

    const second = await pipeline.processAutoDevDocument(doc, { test: true, force: false });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.job.id, firstId);

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(saved.jobs[firstId], 'state에 동일 id가 유지되어야 함');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: touch only change does not reprocess same content');
}

async function test_review_failure_triggers_single_revise_loop() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_REVIEW_REVISE.md', '# A\nx');
  let reviewCalls = 0;
  let claudeCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    '../src/reviewer': {
      runReview: async () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? { summary: { pass: false }, message: 'review failed' }
          : { summary: { pass: true }, message: 'review ok' };
      },
    },
    child_process: {
      execFileSync: (command) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') {
          claudeCalls += 1;
          return 'ok';
        }
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: () => '',
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 1,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(reviewCalls, 2);
    assert.strictEqual(claudeCalls, 2, 'initial implementation + revise_after_review');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true' }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: review failure triggers single revise_after_review loop');
}

async function test_test_failure_triggers_single_revise_loop() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_TEST_REVISE.md', '# A\nx');
  let buildCalls = 0;
  let claudeCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    '../src/builder': {
      runBuildCheck: async () => {
        buildCalls += 1;
        return buildCalls === 1
          ? { pass: false, message: 'build failed', results: [] }
          : { pass: true, message: 'build ok', results: [] };
      },
    },
    child_process: {
      execFileSync: (command) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') {
          claudeCalls += 1;
          return 'ok';
        }
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: () => '',
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 1,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(buildCalls, 2);
    assert.strictEqual(claudeCalls, 2, 'initial implementation + revise_after_test');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true' }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: test failure triggers single revise_after_test loop');
}

async function test_state_file_override_is_used() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_STATE.md', '# A\nx');
  const statePath = path.join(tmpRoot, 'custom-state.json');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    assert.strictEqual(pipeline.STATE_FILE, statePath);
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(statePath), 'override state 파일이 생성되어야 함');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_STATE_FILE: statePath }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: CLAUDE_AUTO_DEV_STATE_FILE override works');
}

async function test_launchd_plist_defaults_are_safe() {
  const plist = fs.readFileSync(AUTO_DEV_PLIST_PATH, 'utf8');
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_ENABLED<\/key>\s*<string>false<\/string>/);
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_SHADOW<\/key>\s*<string>true<\/string>/);
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION<\/key>\s*<string>false<\/string>/);
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_RUN_HARD_TESTS<\/key>\s*<string>false<\/string>/);
  console.log('✅ auto-dev: launchd plist safe defaults verified');
}

async function main() {
  console.log('=== Auto Dev Pipeline 테스트 시작 ===\n');
  const tests = [
    test_stages_define_required_lifecycle,
    test_listAutoDevDocuments_uses_auto_dev_only,
    test_analyzeAutoDevDocument_extracts_code_refs,
    test_processAutoDevDocument_runs_full_dry_pipeline,
    test_completed_job_is_skipped_without_force,
    test_content_hash_job_id_prevents_touch_reprocessing,
    test_review_failure_triggers_single_revise_loop,
    test_test_failure_triggers_single_revise_loop,
    test_state_file_override_is_used,
    test_launchd_plist_defaults_are_safe,
  ];

  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (error) {
      console.error(`❌ ${test.name}: ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
