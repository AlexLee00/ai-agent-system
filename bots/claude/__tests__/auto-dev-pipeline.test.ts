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
const crypto = require('crypto');

const PIPELINE_PATH = path.resolve(__dirname, '../lib/auto-dev-pipeline.ts');
const AUTO_DEV_PLIST_PATH = path.resolve(__dirname, '../launchd/ai.claude.auto-dev.plist');
const AUTO_DEV_SHADOW_PLIST_PATH = path.resolve(__dirname, '../launchd/ai.claude.auto-dev.shadow.plist');
const AUTO_DEV_AUTONOMOUS_PLIST_PATH = path.resolve(__dirname, '../launchd/ai.claude.auto-dev.autonomous.plist');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auto-dev-'));
}

function withRequiredMetadata(body, overrides = {}) {
  const writeScope = overrides.write_scope || ['bots/claude/**'];
  const testScope = overrides.test_scope || ['npm --prefix bots/claude run test:auto-dev'];
  const lines = [
    '---',
    `target_team: ${overrides.target_team || 'claude'}`,
    `owner_agent: ${overrides.owner_agent || 'codex'}`,
    `risk_tier: ${overrides.risk_tier || 'normal'}`,
    `task_type: ${overrides.task_type || 'development_task'}`,
    ...(overrides.implementation_status
      ? [`implementation_status: ${overrides.implementation_status}`]
      : []),
    'write_scope:',
    ...writeScope.map(item => `  - ${item}`),
    'test_scope:',
    ...testScope.map(item => `  - ${item}`),
    `autonomy_level: ${overrides.autonomy_level || 'supervised_l4'}`,
    `requires_live_execution: ${overrides.requires_live_execution ?? false}`,
    '---',
    '',
    body,
  ];
  return lines.join('\n');
}

function makeDoc(tmpRoot, fileName = 'CODEX_SAMPLE.md', content = '# A\nx') {
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const filePath = path.join(autoDir, fileName);
  const normalizedContent = /target_team\s*:/.test(content)
    ? content
    : withRequiredMetadata(content);
  fs.writeFileSync(filePath, normalizedContent, 'utf8');
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
    CLAUDE_AUTO_DEV_COMPAT_MODE: 'true',
    CLAUDE_AUTO_DEV_LOCK_FILE: path.join(tmpRoot, 'claude-auto-dev.lock'),
    CLAUDE_AUTO_DEV_JOB_LOCK_DIR: path.join(tmpRoot, 'claude-auto-dev-job-locks'),
    CLAUDE_AUTO_DEV_WORKTREE_DIR: path.join(tmpRoot, 'claude-auto-dev-worktrees'),
    CLAUDE_AUTO_DEV_ARTIFACT_DIR: path.join(tmpRoot, 'claude-auto-dev-artifacts'),
    ...extra,
  };
}

function computeJobId(tmpRoot, filePath, content) {
  const relPath = path.relative(tmpRoot, filePath).replace(/\\/g, '/');
  const contentHash = crypto.createHash('sha1').update(content || '').digest('hex').slice(0, 16);
  return crypto.createHash('sha1').update(`${relPath}:${contentHash}`).digest('hex').slice(0, 16);
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
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'auto_dev', 'CODEX_SAMPLE.md'), withRequiredMetadata('# A'), 'utf8');
  fs.writeFileSync(
    path.join(tmpRoot, 'docs', 'auto_dev', 'CODEX_NOTE.md'),
    withRequiredMetadata('# Note', { task_type: 'planning_note' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'docs', 'auto_dev', 'CODEX_DONE.md'),
    withRequiredMetadata('# Done', { implementation_status: 'auto_dev_implementation_completed' }),
    'utf8'
  );
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'codex', 'CODEX_OLD.md'), withRequiredMetadata('# B'), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, ['docs/auto_dev/CODEX_SAMPLE.md']);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: scans actionable docs/auto_dev development tasks only');
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

async function test_completed_document_is_updated_after_actual_implementation() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_MARK_COMPLETE.md', '# Complete\nupdate the doc');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      shadow: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.job.implementationStatus, 'auto_dev_implementation_completed');
    assert.strictEqual(result.job.completionDocumentPath, 'docs/auto_dev/CODEX_MARK_COMPLETE.md');
    const content = fs.readFileSync(doc, 'utf8');
    assert.match(content, /implementation_status: auto_dev_implementation_completed/);
    assert.match(content, /implementation_completed_at:/);
    assert.match(content, /<!-- auto_dev:implementation_completed -->/);
    assert.match(content, /## Implementation Completed/);
    assert.deepStrictEqual(pipeline.listAutoDevDocuments(), []);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed implementation updates source document marker and summary');
}

async function test_non_development_task_is_blocked() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_NOTE.md',
    withRequiredMetadata('# Note\nnot a dev task', { task_type: 'planning_note' })
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'blocked_non_development_task');
    assert.strictEqual(result.job.status, 'blocked');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: non-development auto_dev docs are blocked');
}

async function test_implementation_completed_marker_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_DONE.md',
    withRequiredMetadata('# Done\nalready implemented', {
      implementation_status: 'auto_dev_implementation_completed',
    })
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job.status, 'completed');
    assert.strictEqual(result.job.stage, 'implementation_completed');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: implementation-completed marker prevents reprocessing');
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

async function test_missing_metadata_is_blocked() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const doc = path.join(autoDir, 'CODEX_MISSING_METADATA.md');
  fs.writeFileSync(doc, '# Missing\nmetadata 없음', 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'blocked_missing_metadata');
    assert.strictEqual(result.job.status, 'blocked');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: missing metadata is fail-closed');
}

async function test_non_claude_target_is_routed() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_LUNA_SCOPE.md',
    withRequiredMetadata('# Luna\nscope', { target_team: 'luna' })
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'routed_non_claude');
    assert.strictEqual(result.job.status, 'routed');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: non-claude target docs are routed');
}

async function test_global_lock_blocks_parallel_pipeline() {
  const tmpRoot = makeTempRoot();
  makeDoc(tmpRoot, 'CODEX_LOCK.md', '# Lock\ntest');
  const lockPath = path.join(tmpRoot, 'claude-auto-dev.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    token: 'lock-token',
    pid: 1234,
    hostname: 'test-host',
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.runAutoDevPipeline({ once: true, test: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results[0].reason, 'locked_global');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_LOCK_FILE: lockPath }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: global lock blocks parallel run');
}

async function test_job_lock_blocks_duplicate_document_execution() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_JOB_LOCK.md', '# Lock\ndup');
  const content = fs.readFileSync(doc, 'utf8');
  const jobId = computeJobId(tmpRoot, doc, content);
  const lockDir = path.join(tmpRoot, 'claude-auto-dev-job-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${jobId}.lock`), JSON.stringify({
    token: 'job-lock-token',
    pid: 2222,
    hostname: 'test-host',
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { test: true, force: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'locked_job');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_JOB_LOCK_DIR: lockDir }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: job lock blocks duplicate execution');
}

async function test_completed_state_clears_active_error() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CLEAR_ERROR.md', '# A\nx');
  let call = 0;
  const { mocks } = makeMocks(tmpRoot, {
    '../src/reviewer': {
      runReview: async () => {
        call += 1;
        if (call === 1) return { summary: { pass: false }, message: 'review failed once' };
        return { summary: { pass: true }, message: 'review ok' };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const failed = await pipeline.processAutoDevDocument(doc, {
      test: true,
      force: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(failed.ok, false);
  }, testEnv(tmpRoot));

  await withMocks(mocks, async pipeline => {
    const succeeded = await pipeline.processAutoDevDocument(doc, {
      test: true,
      force: true,
      maxRevisionPasses: 1,
    });
    assert.strictEqual(succeeded.ok, true);
    assert.strictEqual(succeeded.job.status, 'completed');
    assert.strictEqual('error' in succeeded.job, false);
    assert.ok(succeeded.job.lastError, 'completed 상태에 lastError는 보존되어야 함');
    assert.ok(Array.isArray(succeeded.job.events));
    assert.ok(succeeded.job.events.some(event => event.type === 'job_completed_after_failure'));
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed state clears active error and keeps history in events');
}

async function test_launchd_plist_defaults_are_safe() {
  const plist = fs.readFileSync(AUTO_DEV_PLIST_PATH, 'utf8');
  const shadowPlist = fs.readFileSync(AUTO_DEV_SHADOW_PLIST_PATH, 'utf8');
  const autonomousPlist = fs.readFileSync(AUTO_DEV_AUTONOMOUS_PLIST_PATH, 'utf8');
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_PROFILE<\/key>\s*<string>shadow<\/string>/);
  assert.match(shadowPlist, /<key>CLAUDE_AUTO_DEV_PROFILE<\/key>\s*<string>shadow<\/string>/);
  assert.match(autonomousPlist, /<key>CLAUDE_AUTO_DEV_PROFILE<\/key>\s*<string>autonomous_l5<\/string>/);
  assert.doesNotMatch(shadowPlist, /CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION/);
  assert.doesNotMatch(autonomousPlist, /CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  console.log('✅ auto-dev: launchd plist safe defaults verified');
}

async function test_profile_resolver_maps_runtime_profiles() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const shadow = pipeline.resolveAutoDevRuntimeConfig({ profile: 'shadow' }, {});
    assert.strictEqual(shadow.enabled, false);
    assert.strictEqual(shadow.shadow, true);
    assert.strictEqual(shadow.executeImplementation, false);
    assert.strictEqual(shadow.integrationMode, 'patch');

    const supervised = pipeline.resolveAutoDevRuntimeConfig({ profile: 'supervised_l4' }, {});
    assert.strictEqual(supervised.enabled, true);
    assert.strictEqual(supervised.shadow, true);
    assert.strictEqual(supervised.executeImplementation, false);

    const autonomous = pipeline.resolveAutoDevRuntimeConfig({ profile: 'autonomous_l5' }, {});
    assert.strictEqual(autonomous.enabled, true);
    assert.strictEqual(autonomous.shadow, false);
    assert.strictEqual(autonomous.executeImplementation, true);
    assert.strictEqual(autonomous.archiveOnSuccess, true);
    assert.strictEqual(autonomous.runHardTests, true);
    assert.strictEqual(autonomous.integrationMode, 'cherry_pick');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: promotion profiles resolve to runtime flags');
}

async function test_profile_authoritative_blocks_legacy_overrides() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const runtime = pipeline.resolveAutoDevRuntimeConfig({}, {
      CLAUDE_AUTO_DEV_PROFILE: 'shadow',
      CLAUDE_AUTO_DEV_ENABLED: 'true',
      CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
      CLAUDE_AUTO_DEV_ARCHIVE_ON_SUCCESS: 'true',
      CLAUDE_AUTO_DEV_RUN_HARD_TESTS: 'true',
      CLAUDE_AUTO_DEV_INTEGRATION_MODE: 'cherry_pick',
      CLAUDE_AUTO_DEV_COMPAT_MODE: 'false',
    });

    assert.strictEqual(runtime.profile, 'shadow');
    assert.strictEqual(runtime.compatibilityMode, false);
    assert.strictEqual(runtime.enabled, false);
    assert.strictEqual(runtime.executeImplementation, false);
    assert.strictEqual(runtime.archiveOnSuccess, false);
    assert.strictEqual(runtime.runHardTests, false);
    assert.strictEqual(runtime.integrationMode, 'patch');
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:enabled'));
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:executeImplementation'));
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:CLAUDE_AUTO_DEV_INTEGRATION_MODE'));
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: profile authoritative mode ignores legacy env overrides');
}

async function test_profile_compatibility_mode_allows_legacy_overrides() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const runtime = pipeline.resolveAutoDevRuntimeConfig({}, {
      CLAUDE_AUTO_DEV_PROFILE: 'shadow',
      CLAUDE_AUTO_DEV_ENABLED: 'true',
      CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
      CLAUDE_AUTO_DEV_ARCHIVE_ON_SUCCESS: 'true',
      CLAUDE_AUTO_DEV_RUN_HARD_TESTS: 'true',
      CLAUDE_AUTO_DEV_INTEGRATION_MODE: 'cherry_pick',
      CLAUDE_AUTO_DEV_COMPAT_MODE: 'true',
    });

    assert.strictEqual(runtime.compatibilityMode, true);
    assert.strictEqual(runtime.enabled, true);
    assert.strictEqual(runtime.executeImplementation, true);
    assert.strictEqual(runtime.archiveOnSuccess, true);
    assert.strictEqual(runtime.runHardTests, true);
    assert.strictEqual(runtime.integrationMode, 'cherry_pick');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: compatibility mode allows legacy env overrides');
}

async function test_bash_is_fail_closed_without_allowlist() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_BASH_BLOCK.md', '# Bash\nblock');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /Bash tool.+차단|allowlist/i);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
    CLAUDE_AUTO_DEV_ALLOWED_TOOLS: 'Edit,Write,Bash,Read',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: Bash is fail-closed without allowlist');
}

async function test_lock_heartbeat_sidecar_enforces_parent_liveness() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_HEARTBEAT_PID.md', '# Heartbeat\npid');
  const spawnedScripts = [];

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command) => {
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: () => '',
      spawn: (_command, args = []) => {
        spawnedScripts.push(String(args[1] || ''));
        const child = {
          killed: false,
          kill: () => { child.killed = true; },
          on: () => child,
          unref: () => {},
        };
        return child;
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      force: true,
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot));

  assert.ok(spawnedScripts.length > 0, 'heartbeat sidecar must be spawned');
  const sidecarScript = spawnedScripts.join('\n');
  assert.match(sidecarScript, /process\.ppid\s*!==\s*ownerPid/);
  assert.match(sidecarScript, /process\.kill\(pid,\s*0\)/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: lock heartbeat sidecar validates parent liveness');
}

async function test_review_cycle_uses_execution_context() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_REVIEW_SCOPE.md', '# Review\nscope');
  let reviewerOptions = null;
  let guardianOptions = null;

  const { mocks } = makeMocks(tmpRoot, {
    '../src/reviewer': {
      runReview: async (opts) => {
        reviewerOptions = opts;
        return { summary: { pass: true }, message: 'review ok' };
      },
    },
    '../src/guardian': {
      runFullSecurityScan: async (opts) => {
        guardianOptions = opts;
        return { pass: true, message: 'guardian ok', critical: [], high: [], layers: {} };
      },
    },
    child_process: {
      execFileSync: (command) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: (command) => {
        if (String(command).includes('git status --short')) return ' M bots/claude/src/reviewer.ts\n';
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
    CLAUDE_AUTO_DEV_ALLOW_DIRTY_BASE: 'true',
  }));

  assert.ok(reviewerOptions && guardianOptions, 'reviewer/guardian 호출 옵션이 기록되어야 함');
  assert.ok(String(reviewerOptions.rootDir || '').includes('claude-auto-dev-worktrees'));
  assert.ok(Array.isArray(reviewerOptions.files), 'reviewer files 전달 필요');
  assert.ok(Array.isArray(guardianOptions.files), 'guardian files 전달 필요');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: review/guardian use worktree execution context');
}

async function test_test_scope_is_executed_in_non_test_mode() {
  const tmpRoot = makeTempRoot();
  const scopedCommand = 'npm --prefix bots/claude run test:auto-dev';
  const doc = makeDoc(
    tmpRoot,
    'CODEX_TEST_SCOPE.md',
    withRequiredMetadata('# Scope\nrun', { test_scope: [scopedCommand] })
  );
  const executedCommands = [];

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: (command) => {
        executedCommands.push(String(command));
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(
    executedCommands.some(command =>
      command.includes('npm --prefix') && command.includes('run test:auto-dev')),
    'test_scope command must be executed in non-test mode'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: test_scope commands are executed');
}

async function test_test_scope_rejects_unsafe_shell_command() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_TEST_SCOPE_UNSAFE.md',
    withRequiredMetadata('# Unsafe Scope\nblock', { test_scope: ['echo pwned && whoami'] })
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /test_scope 항목|허용되지 않은 명령|allow/i);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: unsafe test_scope shell command is blocked');
}

async function test_archive_manifest_is_created() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_ARCHIVE_MANIFEST.md', '# Archive\nmanifest');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      force: true,
      archiveOnSuccess: true,
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.job.archivedPath, 'archive path should exist');
    assert.ok(result.job.archiveManifestPath, 'archive manifest should exist');
    assert.ok(fs.existsSync(path.join(tmpRoot, result.job.archivedPath)));
    assert.ok(fs.existsSync(path.join(tmpRoot, result.job.archiveManifestPath)));
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, result.job.archiveManifestPath), 'utf8'));
    assert.strictEqual(manifest.implementationStatus, 'auto_dev_implementation_completed');
    const archivedContent = fs.readFileSync(path.join(tmpRoot, result.job.archivedPath), 'utf8');
    assert.match(archivedContent, /implementation_status: auto_dev_implementation_completed/);
    assert.match(archivedContent, /## Implementation Completed/);
    assert.match(archivedContent, /archive_manifest:/);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archive manifest is created');
}

async function test_archive_manifest_failure_is_fail_closed() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_ARCHIVE_MANIFEST_FAIL.md', '# Archive\nmanifest fail');
  const realFs = require('fs');
  const fsMock = {
    ...realFs,
    writeFileSync: (targetPath, ...args) => {
      if (String(targetPath).endsWith('.manifest.json')) {
        throw new Error('manifest_write_failed');
      }
      return realFs.writeFileSync(targetPath, ...args);
    },
  };
  const { mocks } = makeMocks(tmpRoot, { fs: fsMock });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      force: true,
      archiveOnSuccess: true,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /archive failed|manifest_write_failed/i);
    assert.ok(fs.existsSync(doc), 'archive failure should roll back source document');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archive manifest failure is fail-closed');
}

async function test_archive_manifest_failure_rolls_back_cherry_pick() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_ARCHIVE_ROLLBACK.md', '# Archive\nrollback');
  const gitCalls = [];
  let worktreeStatusCalls = 0;
  let cherryPicked = false;
  let reverted = false;
  const realFs = require('fs');
  const fsMock = {
    ...realFs,
    writeFileSync: (targetPath, ...args) => {
      if (String(targetPath).endsWith('.manifest.json')) {
        throw new Error('manifest_write_failed');
      }
      return realFs.writeFileSync(targetPath, ...args);
    },
  };
  const { mocks } = makeMocks(tmpRoot, {
    fs: fsMock,
    child_process: {
      execFileSync: (command, args = [], opts = {}) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        if (command === 'git') {
          gitCalls.push({ args, cwd: opts.cwd });
          const joined = args.join(' ');
          const inWorktree = String(opts.cwd || '').includes('claude-auto-dev-worktrees');
          if (joined === 'rev-parse --is-inside-work-tree') return 'true\n';
          if (joined === 'rev-parse HEAD') {
            if (inWorktree) return 'worktree-commit\n';
            if (reverted) return 'rollback-commit\n';
            if (cherryPicked) return 'target-commit\n';
            return 'base-head\n';
          }
          if (joined === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (joined === 'cherry-pick worktree-commit') {
            cherryPicked = true;
            return '';
          }
          if (joined === 'revert --no-edit target-commit') {
            reverted = true;
            return '';
          }
          if (joined.startsWith('diff')) {
            return 'diff --git a/bots/claude/src/reviewer.ts b/bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
      execSync: (command, opts = {}) => {
        if (String(command).includes('git status --short')) {
          if (String(opts.cwd || '').includes('claude-auto-dev-worktrees')) {
            worktreeStatusCalls += 1;
            return worktreeStatusCalls === 1 ? '' : ' M bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      integrationMode: 'cherry_pick',
      archiveOnSuccess: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /archive failed|manifest_write_failed/i);
    assert.strictEqual(result.job.integrationRollback?.rolledBack, true);
  }, testEnv(tmpRoot));

  assert.ok(
    gitCalls.some(call => call.args.join(' ') === 'revert --no-edit target-commit'),
    'archive failure after cherry-pick must revert integrated commit'
  );
  assert.ok(fs.existsSync(doc), 'archive failure should restore source document');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archive manifest failure rolls back cherry-picked integration');
}

async function test_worktree_cleanup_runs_after_success() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CLEANUP_WORKTREE.md', '# Cleanup\nworktree');
  const gitCalls = [];
  let worktreeStatusCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = [], opts = {}) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        if (command === 'git') {
          gitCalls.push({ args, cwd: opts.cwd });
          const joined = args.join(' ');
          if (joined === 'rev-parse --is-inside-work-tree') return 'true\n';
          if (joined === 'rev-parse HEAD') return String(opts.cwd || '').includes('claude-auto-dev-worktrees')
            ? 'worktree-head\n'
            : 'base-head\n';
          if (joined.startsWith('diff')) {
            return 'diff --git a/bots/claude/src/reviewer.ts b/bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
      execSync: (command, opts = {}) => {
        if (String(command).includes('git status --short')) {
          if (String(opts.cwd || '').includes('claude-auto-dev-worktrees')) {
            worktreeStatusCalls += 1;
            return worktreeStatusCalls === 1 ? '' : ' M bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.job.worktreeCleanup?.removed, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(
    gitCalls.some(call => call.args.join(' ').startsWith('worktree remove --force')),
    'successful worktree jobs must remove the detached worktree'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: worktree cleanup runs after successful job');
}

async function test_cherry_pick_integration_commits_and_applies_patch() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CHERRY_PICK.md', '# Cherry\npick');
  const gitCalls = [];
  let worktreeStatusCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = [], opts = {}) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        if (command === 'git') {
          gitCalls.push({ args, cwd: opts.cwd });
          const joined = args.join(' ');
          const inWorktree = String(opts.cwd || '').includes('claude-auto-dev-worktrees');
          if (joined === 'rev-parse --is-inside-work-tree') return 'true\n';
          if (joined === 'rev-parse HEAD') return inWorktree ? 'worktree-commit\n' : 'base-head\n';
          if (joined === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (joined.startsWith('diff')) {
            return 'diff --git a/bots/claude/src/reviewer.ts b/bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
      execSync: (command, opts = {}) => {
        if (String(command).includes('git status --short')) {
          if (String(opts.cwd || '').includes('claude-auto-dev-worktrees')) {
            worktreeStatusCalls += 1;
            return worktreeStatusCalls === 1 ? '' : ' M bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      integrationMode: 'cherry_pick',
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.integration.mode, 'cherry_picked');
    assert.strictEqual(result.integration.targetBranch, 'main');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(gitCalls.some(call => call.args.includes('commit')), 'worktree changes must be committed before cherry-pick');
  assert.ok(gitCalls.some(call => call.args[0] === 'cherry-pick'), 'worktree commit must be cherry-picked into main');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: cherry-pick integration commits and applies patch');
}

async function test_cherry_pick_failure_aborts_and_fails_closed() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CHERRY_PICK_FAIL.md', '# Cherry\npick fail');
  const gitCalls = [];
  let worktreeStatusCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = [], opts = {}) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        if (command === 'git') {
          gitCalls.push({ args, cwd: opts.cwd });
          const joined = args.join(' ');
          const inWorktree = String(opts.cwd || '').includes('claude-auto-dev-worktrees');
          if (joined === 'rev-parse --is-inside-work-tree') return 'true\n';
          if (joined === 'rev-parse HEAD') return inWorktree ? 'worktree-commit\n' : 'base-head\n';
          if (joined === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (joined === 'cherry-pick worktree-commit') {
            const error = new Error('cherry_pick_conflict');
            error.stderr = 'CONFLICT (content): Merge conflict in bots/claude/src/reviewer.ts';
            throw error;
          }
          if (joined === 'cherry-pick --abort') return '';
          if (joined.startsWith('diff')) {
            return 'diff --git a/bots/claude/src/reviewer.ts b/bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
      execSync: (command, opts = {}) => {
        if (String(command).includes('git status --short')) {
          if (String(opts.cwd || '').includes('claude-auto-dev-worktrees')) {
            worktreeStatusCalls += 1;
            return worktreeStatusCalls === 1 ? '' : ' M bots/claude/src/reviewer.ts\n';
          }
          return '';
        }
        return '';
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      integrationMode: 'cherry_pick',
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /integration failed|cherry-pick failed/i);
  }, testEnv(tmpRoot));

  assert.ok(
    gitCalls.some(call => call.args.join(' ') === 'cherry-pick --abort'),
    'cherry-pick conflict must trigger cherry-pick --abort'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: cherry-pick failure aborts and fails closed');
}

async function test_status_snapshot_includes_profile_worktree_patch_counts() {
  const tmpRoot = makeTempRoot();
  makeDoc(tmpRoot, 'CODEX_STATUS.md', '# Status\nsnapshot');
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  const worktreeDir = path.join(tmpRoot, 'claude-auto-dev-worktrees');
  const artifactDir = path.join(tmpRoot, 'claude-auto-dev-artifacts');
  fs.mkdirSync(path.join(worktreeDir, 'job-1'), { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'one.patch'), 'diff --git a/a b/a\n', 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      one: {
        id: 'one',
        relPath: 'docs/auto_dev/CODEX_STATUS.md',
        status: 'completed',
        stage: 'completed',
        title: 'Status',
        updatedAt: new Date().toISOString(),
      },
    },
  }), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const snapshot = pipeline.getAutoDevStatusSnapshot({ profile: 'supervised_l4' });
    assert.strictEqual(snapshot.profile, 'supervised_l4');
    assert.strictEqual(snapshot.counts.pendingDocs, 1);
    assert.strictEqual(snapshot.counts.worktrees, 1);
    assert.strictEqual(snapshot.counts.patches, 1);
    assert.strictEqual(snapshot.counts.completedJobs, 1);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
    CLAUDE_AUTO_DEV_WORKTREE_DIR: worktreeDir,
    CLAUDE_AUTO_DEV_ARTIFACT_DIR: artifactDir,
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: status snapshot includes profile/worktree/patch counts');
}

async function main() {
  console.log('=== Auto Dev Pipeline 테스트 시작 ===\n');
  const tests = [
    test_stages_define_required_lifecycle,
    test_listAutoDevDocuments_uses_auto_dev_only,
    test_analyzeAutoDevDocument_extracts_code_refs,
    test_processAutoDevDocument_runs_full_dry_pipeline,
    test_completed_document_is_updated_after_actual_implementation,
    test_completed_job_is_skipped_without_force,
    test_content_hash_job_id_prevents_touch_reprocessing,
    test_review_failure_triggers_single_revise_loop,
    test_test_failure_triggers_single_revise_loop,
    test_state_file_override_is_used,
    test_missing_metadata_is_blocked,
    test_non_development_task_is_blocked,
    test_implementation_completed_marker_is_skipped,
    test_non_claude_target_is_routed,
    test_global_lock_blocks_parallel_pipeline,
    test_job_lock_blocks_duplicate_document_execution,
    test_completed_state_clears_active_error,
    test_launchd_plist_defaults_are_safe,
    test_profile_resolver_maps_runtime_profiles,
    test_profile_authoritative_blocks_legacy_overrides,
    test_profile_compatibility_mode_allows_legacy_overrides,
    test_bash_is_fail_closed_without_allowlist,
    test_lock_heartbeat_sidecar_enforces_parent_liveness,
    test_review_cycle_uses_execution_context,
    test_test_scope_is_executed_in_non_test_mode,
    test_test_scope_rejects_unsafe_shell_command,
    test_archive_manifest_is_created,
    test_archive_manifest_failure_is_fail_closed,
    test_archive_manifest_failure_rolls_back_cherry_pick,
    test_worktree_cleanup_runs_after_success,
    test_cherry_pick_integration_commits_and_applies_patch,
    test_cherry_pick_failure_aborts_and_fails_closed,
    test_status_snapshot_includes_profile_worktree_patch_counts,
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
