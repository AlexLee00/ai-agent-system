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
const GIT_OPS_PATH = path.resolve(__dirname, '../lib/git-ops.ts');
const AUTO_DEV_MANIFEST_PATH = path.resolve(__dirname, '../../../packages/core/lib/auto-dev-manifest.ts');
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
  const repairCallbacks = [];
  const repairProgress = [];
  const autoDevOutcomes = [];
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
    repairCallbacks,
    repairProgress,
    autoDevOutcomes,
    mocks: {
      '../../../packages/core/lib/env': { PROJECT_ROOT: tmpRoot },
      '../../../packages/core/lib/hub-alarm-client': {
        postAlarm: async payload => {
          alarms.push(payload);
          return { ok: true };
        },
        postAlarmAutoRepairResult: async payload => {
          repairCallbacks.push(payload);
          return { ok: true, mirrorUpdate: { ok: true, updated: 1 } };
        },
        postAlarmAutoRepairProgress: async payload => {
          repairProgress.push(payload);
          return { ok: true, eventId: repairProgress.length };
        },
      },
      '../../../packages/core/lib/pg-pool.js': {
        query: async (schema, sql, params = []) => {
          if (schema === 'claude' && /INSERT INTO claude\.auto_dev_outcomes/.test(sql)) {
            const row = {
              id: autoDevOutcomes.length + 1,
              job_id: params[0],
              rel_path: params[1],
              outcome: params[2],
              stage: params[3],
              content_hash: params[4],
              attempts: params[5],
              stale_recovery_count: params[6],
              duration_ms: params[7],
              test_pass: params[8],
              error_summary: params[9],
              commit_sha: params[10],
              meta: params[11],
            };
            autoDevOutcomes.push(row);
            return [{ id: row.id }];
          }
          return [];
        },
      },
      './team-bus': {
        setStatus: async () => {},
        markDone: async () => {},
        markError: async () => {},
      },
      './agent-heartbeat': {
        writeClaudeHeartbeat: async () => ({ ok: true }),
        errorHeartbeatMeta: (error, meta = {}) => ({ ...meta, message: error?.message || String(error) }),
      },
      '../src/reviewer.ts': {
        runReview: async () => ({ summary: { pass: true }, message: 'review ok' }),
      },
      '../src/guardian.ts': {
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

async function test_alarm_repair_progress_carries_attempt_contract() {
  const tmpRoot = makeTempRoot();
  const { mocks, repairProgress } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const job = {
      relPath: 'docs/auto_dev/ALARM_INCIDENT_PROGRESS.md',
      contentHash: 'progress-hash',
      analysis: {
        relPath: 'docs/auto_dev/ALARM_INCIDENT_PROGRESS.md',
        metadata: {
          source_team: 'reservation',
          incident_key: 'reservation:service_health:ai.ska.kiosk-monitor',
          alarm_event_id: '33310150',
        },
      },
    };
    const result = await pipeline._testOnly_sendAlarmRepairProgress(job, 'retry_pending', {
      attempt: 1,
      maxAttempts: 3,
      nextRetryAt: '2026-07-20T01:05:00.000Z',
      summary: 'retry scheduled',
    }, { shadow: false, test: false });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot));

  assert.strictEqual(repairProgress.length, 1);
  assert.strictEqual(repairProgress[0].state, 'retry_pending');
  assert.strictEqual(repairProgress[0].attempt, 1);
  assert.strictEqual(repairProgress[0].maxAttempts, 3);
  assert.strictEqual(repairProgress[0].nextRetryAt, '2026-07-20T01:05:00.000Z');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: repair progress carries retry attempt contract');
}

async function withMocks(mocks, fn, env = {}) {
  const original = Module._load;
  const originalEnv = {};
  const effectiveMocks = { ...mocks };

  if (effectiveMocks.child_process?.execFileSync && effectiveMocks.child_process?.execSync) {
    const childProcessMock = effectiveMocks.child_process;
    effectiveMocks.child_process = {
      ...childProcessMock,
      execFileSync(command, args = [], opts = {}) {
        if (command === 'git' && Array.isArray(args) && args[0] === 'status' && args[1] === '--short') {
          return childProcessMock.execSync('git status --short', opts);
        }
        return childProcessMock.execFileSync(command, args, opts);
      },
    };
  }

  for (const [key, value] of Object.entries(env)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request in effectiveMocks) return effectiveMocks[request];
    return original.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[PIPELINE_PATH];
    delete require.cache[GIT_OPS_PATH];
    delete require.cache[AUTO_DEV_MANIFEST_PATH];
    return await fn(require(PIPELINE_PATH));
  } finally {
    Module._load = original;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    delete require.cache[PIPELINE_PATH];
    delete require.cache[GIT_OPS_PATH];
    delete require.cache[AUTO_DEV_MANIFEST_PATH];
  }
}

function testEnv(tmpRoot, extra = {}) {
  return {
    PROJECT_ROOT: tmpRoot,
    CLAUDE_AUTO_DEV_STATE_FILE: path.join(tmpRoot, 'auto-dev-state.json'),
    CLAUDE_AUTO_DEV_RUN_HARD_TESTS: 'false',
    CLAUDE_AUTO_DEV_COMPAT_MODE: 'true',
    CLAUDE_AUTO_DEV_ARCHIVE_ON_SUCCESS: 'false',
    CLAUDE_AUTO_DEV_MODEL: '',
    CLAUDE_CODE_MODEL: '',
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

async function test_manifest_lock_release_preserves_replacement_owner() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const lockPath = path.join(autoDir, '.auto-dev-manifest.json.lock');
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);

  manifestLib._testOnly_withManifestLock(autoDir, () => {
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, 'replacement-owner\n', 'utf8');
  });

  assert.strictEqual(fs.existsSync(lockPath), true, 'an old owner must not delete a replacement lock');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8').trim(), 'replacement-owner');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: manifest lock release preserves replacement owner');
}

async function test_manifest_async_lock_wait_yields_event_loop() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const lockPath = path.join(autoDir, '.auto-dev-manifest.json.lock');
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(lockPath, `${process.pid}:existing-owner\n`, 'utf8');

  let timerFired = false;
  const releaseTimer = setTimeout(() => {
    timerFired = true;
    fs.unlinkSync(lockPath);
  }, 40);
  try {
    await manifestLib._testOnly_withManifestLockAsync(autoDir, async () => {
      assert.strictEqual(timerFired, true, 'async lock wait must yield to the event loop');
    });
  } finally {
    clearTimeout(releaseTimer);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('✅ auto-dev: async manifest lock wait yields event loop');
}

async function test_manifest_stale_reclaim_serializes_contenders() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const lockPath = path.join(autoDir, '.auto-dev-manifest.json.lock');
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(lockPath, '99999999:stale-owner\n', 'utf8');
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  let active = 0;
  let maxActive = 0;
  const contender = () => manifestLib._testOnly_withManifestLockAsync(autoDir, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
  });
  try {
    await Promise.all([contender(), contender()]);
    assert.strictEqual(maxActive, 1, 'stale reclaim must preserve mutual exclusion');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('✅ auto-dev: stale manifest lock reclaim serializes contenders');
}

async function test_manifest_stale_empty_lock_is_recoverable() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const lockPath = path.join(autoDir, '.auto-dev-manifest.json.lock');
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(lockPath, '', 'utf8');
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  let acquired = false;
  try {
    await manifestLib._testOnly_withManifestLockAsync(autoDir, async () => {
      acquired = true;
    });
    assert.strictEqual(acquired, true, 'stale tokenless lock must be recoverable');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('✅ auto-dev: stale empty manifest lock is recoverable');
}

async function test_manifest_orphan_reclaim_guard_is_recoverable() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const lockPath = path.join(autoDir, '.auto-dev-manifest.json.lock');
  const staleOwner = '99999999:stale-owner';
  const guardHash = crypto.createHash('sha1').update(staleOwner).digest('hex').slice(0, 12);
  const guardPath = `${lockPath}.reclaim-${guardHash}`;
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(lockPath, `${staleOwner}\n`, 'utf8');
  fs.writeFileSync(guardPath, '99999998:orphan-reclaimer\n', 'utf8');
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  fs.utimesSync(guardPath, staleTime, staleTime);

  let acquired = false;
  try {
    await manifestLib._testOnly_withManifestLockAsync(autoDir, async () => {
      acquired = true;
    });
    assert.strictEqual(acquired, true, 'orphan reclaim guard must not block recovery permanently');
    assert.strictEqual(fs.existsSync(guardPath), false, 'orphan reclaim guard must be cleaned');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('✅ auto-dev: orphan manifest reclaim guard is recoverable');
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

async function test_js_bridge_loads_pipeline_status_snapshot() {
  const bridgePath = path.resolve(__dirname, '../lib/auto-dev-pipeline.js');
  delete require.cache[bridgePath];

  const pipeline = require(bridgePath);
  const snapshot = pipeline.getAutoDevStatusSnapshot({
    profile: 'shadow',
  });

  assert.strictEqual(snapshot.ok, true);
  assert.ok(snapshot.counts && typeof snapshot.counts.pendingDocs === 'number');
  assert.ok(Array.isArray(snapshot.pendingDocs));

  delete require.cache[bridgePath];
  console.log('✅ auto-dev: js bridge loads status snapshot');
}

async function test_status_snapshot_reconciles_stale_missing_running_jobs() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_missing_running.md';
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-06-13T00:00:00.000Z',
    entries: {
      [relPath]: {
        relPath,
        state: 'claimed',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      staleMissing: {
        id: 'staleMissing',
        relPath,
        status: 'running',
        stage: 'implementation',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const snapshot = pipeline.getAutoDevStatusSnapshot({ profile: 'supervised_l4' });
    assert.strictEqual(snapshot.counts.pendingDocs, 0);
    assert.strictEqual(snapshot.counts.runningJobs, 0);
    assert.strictEqual(snapshot.state.jobs.staleMissing.status, 'skipped');
    assert.strictEqual(snapshot.state.jobs.staleMissing.stage, 'missing_document_after_listing');
    assert.ok(
      snapshot.state.jobs.staleMissing.events.some(event => event.type === 'stale_missing_document_reconciled'),
      'stale missing running job should record a reconciliation event'
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'archived_missing');
    assert.strictEqual(manifest.entries[relPath].reason, 'missing_document_after_listing');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_RUNNING_STALE_MS: '1',
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: status snapshot reconciles stale missing running jobs');
}

async function test_listAutoDevDocuments_uses_auto_dev_only() {
  const tmpRoot = makeTempRoot();
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'auto_dev'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'auto_dev', 'ALARM_INCIDENT_SAMPLE.md'), withRequiredMetadata('# A'), 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'auto_dev', 'CODEX_SAMPLE.md'), withRequiredMetadata('# Codex'), 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'docs', 'auto_dev', 'PATCH_REQUEST.md'), withRequiredMetadata('# Patch'), 'utf8');
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
    assert.deepStrictEqual(docs.sort(), [
      'docs/auto_dev/ALARM_INCIDENT_SAMPLE.md',
      'docs/auto_dev/CODEX_SAMPLE.md',
      'docs/auto_dev/PATCH_REQUEST.md',
    ].sort());
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: scans actionable docs/auto_dev development tasks only');
}

async function test_listAutoDevDocuments_respects_manifest_states() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, 'ALARM_INCIDENT_active.md'), withRequiredMetadata('# Active'), 'utf8');
  fs.writeFileSync(path.join(autoDir, 'ALARM_INCIDENT_archived.md'), withRequiredMetadata('# Archived'), 'utf8');
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      'docs/auto_dev/ALARM_INCIDENT_active.md': {
        relPath: 'docs/auto_dev/ALARM_INCIDENT_active.md',
        state: 'claimed',
        createdAt: new Date().toISOString(),
      },
      'docs/auto_dev/ALARM_INCIDENT_archived.md': {
        relPath: 'docs/auto_dev/ALARM_INCIDENT_archived.md',
        state: 'archived',
        createdAt: new Date().toISOString(),
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, ['docs/auto_dev/ALARM_INCIDENT_active.md']);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: manifest states gate document pickup');
}

async function test_regenerated_archived_document_reenters_inbox() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const archiveDir = path.join(tmpRoot, 'docs', 'archive', 'codex-completed');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_REGENERATED_HASH.md';
  const archivedPath = 'docs/archive/codex-completed/ALARM_INCIDENT_REGENERATED_HASH.done.md';
  const oldContent = withRequiredMetadata('# Old incident');
  const newContent = withRequiredMetadata('# New incident');
  const oldHash = crypto.createHash('sha1').update(oldContent).digest('hex').slice(0, 16);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, relPath), newContent, 'utf8');
  fs.writeFileSync(path.join(tmpRoot, archivedPath), oldContent, 'utf8');
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived',
        reason: 'completed',
        archivedPath,
        contentHash: oldHash,
        callbackState: 'delivered',
        callbackPayload: { incidentKey: 'old-generation' },
        callbackAttempts: 2,
        callbackEventId: 123,
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, [relPath]);
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'inbox');
    assert.strictEqual(manifest.entries[relPath].source, 'regenerated_content');
    assert.strictEqual(manifest.entries[relPath].callbackState, undefined);
    assert.strictEqual(manifest.entries[relPath].callbackPayload, undefined);
    assert.strictEqual(manifest.entries[relPath].callbackAttempts, undefined);
    assert.strictEqual(manifest.entries[relPath].callbackEventId, undefined);
    assert.deepStrictEqual(
      fs.readdirSync(autoDir).filter(name => name.includes('.auto-dev-manifest.json.')),
      [],
      'atomic manifest writes must not leave temp or lock files',
    );
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: regenerated archived content re-enters inbox');
}

async function test_legacy_archived_document_without_hash_uses_archive_content() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const archiveDir = path.join(tmpRoot, 'docs', 'archive', 'codex-completed');
  const changedRelPath = 'docs/auto_dev/ALARM_INCIDENT_LEGACY_CHANGED.md';
  const sameRelPath = 'docs/auto_dev/ALARM_INCIDENT_LEGACY_SAME.md';
  const changedArchivePath = 'docs/archive/codex-completed/ALARM_INCIDENT_LEGACY_CHANGED.done.md';
  const sameArchivePath = 'docs/archive/codex-completed/ALARM_INCIDENT_LEGACY_SAME.done.md';
  const oldContent = withRequiredMetadata('# Old incident');
  const newContent = withRequiredMetadata('# New incident');
  fs.mkdirSync(autoDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, changedRelPath), newContent, 'utf8');
  fs.writeFileSync(path.join(tmpRoot, sameRelPath), oldContent, 'utf8');
  fs.writeFileSync(path.join(tmpRoot, changedArchivePath), oldContent, 'utf8');
  fs.writeFileSync(path.join(tmpRoot, sameArchivePath), oldContent, 'utf8');
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [changedRelPath]: {
        relPath: changedRelPath,
        state: 'archived',
        reason: 'completed',
        archivedPath: changedArchivePath,
      },
      [sameRelPath]: {
        relPath: sameRelPath,
        state: 'archived',
        reason: 'completed',
        archivedPath: sameArchivePath,
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, [changedRelPath]);
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[changedRelPath].source, 'regenerated_content');
    assert.strictEqual(manifest.entries[sameRelPath].state, 'archived');
    assert.ok(manifest.entries[sameRelPath].contentHash, 'legacy matching archive should receive a baseline hash');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: legacy hashless archives compare content before requeue');
}

async function test_empty_auto_dev_inbox_marks_agent_done() {
  const tmpRoot = makeTempRoot();
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'auto_dev'), { recursive: true });
  const markDoneCalls = [];
  const { mocks } = makeMocks(tmpRoot, {
    './team-bus': {
      setStatus: async () => {},
      markDone: async (...args) => markDoneCalls.push(args),
      markError: async () => {},
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.runAutoDevPipeline({ once: true, test: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(markDoneCalls.length, 1);
    assert.deepStrictEqual(markDoneCalls[0], ['auto-dev']);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: empty inbox marks agent done');
}

async function test_completed_history_prevents_archived_missing_requeue() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_completed.md';
  fs.writeFileSync(path.join(tmpRoot, relPath), withRequiredMetadata('# Completed'), 'utf8');
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived_missing',
        archivedAt: '2026-06-03T00:00:00.000Z',
        archivedBy: 'auto-dev-pipeline',
        archivedPath: 'docs/archive/codex-completed/ALARM_INCIDENT_completed.done.md',
        createdAt: '2026-06-03T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'auto-dev-state.json'), JSON.stringify({
    jobs: {
      completed: {
        id: 'completed',
        relPath,
        status: 'completed',
        stage: 'completed',
        updatedAt: '2026-06-03T00:10:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'archived_missing');
    assert.strictEqual(manifest.entries[relPath].source, 'completed_no_requeue');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed history prevents archived_missing requeue');
}

async function test_completed_manifest_record_blocks_failed_overwrite() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_completed_overwrite.md';
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived',
        archivedAt: '2026-07-06T07:00:00.000Z',
        archivedBy: 'codex',
        archivedPath: 'docs/archive/codex-completed/ALARM_INCIDENT_completed_overwrite.md',
        reason: 'auto_dev_current_state_resolved',
        implementationStatus: 'auto_dev_implementation_completed',
        createdAt: '2026-07-06T06:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async () => {
    const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
    manifestLib.markAutoDevManifestState(autoDir, relPath, 'active', {
      failedAt: '2026-07-06T07:10:00.000Z',
      failureReason: 'ENOENT after archive',
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'archived');
    assert.strictEqual(manifest.entries[relPath].implementationStatus, 'auto_dev_implementation_completed');
    assert.strictEqual(manifest.entries[relPath].failedAt, undefined);
    assert.strictEqual(manifest.entries[relPath].failureReason, undefined);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed manifest record blocks failed overwrite');
}

async function test_completed_manifest_during_execution_suppresses_failure_alarm() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_SUPERSEDED.md';
  const doc = makeDoc(tmpRoot, 'ALARM_INCIDENT_SUPERSEDED.md', [
    '---',
    'target_team: claude',
    'owner_agent: codex',
    'source_team: blog',
    'source_bot: blog-neighbor-commenter',
    'incident_key: blog:blog-neighbor-commenter:test:completed-race',
    'alarm_event_type: blog-neighbor-commenter_error',
    'risk_tier: normal',
    'task_type: development_task',
    'write_scope:',
    '  - bots/claude/**',
    'test_scope:',
    '  - npm --prefix bots/claude run test:auto-dev',
    'autonomy_level: autonomous_l5',
    'requires_live_execution: false',
    '---',
    '',
    '# Superseded failure',
  ].join('\n'));

  const { mocks, alarms, autoDevOutcomes } = makeMocks(tmpRoot, {
    '../src/reviewer.ts': {
      runReview: async () => {
        const manifestPath = path.join(autoDir, '.auto-dev-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.entries[relPath] = {
          ...manifest.entries[relPath],
          state: 'archived',
          reason: 'auto_dev_current_state_resolved',
          implementationStatus: 'auto_dev_implementation_completed',
          contentHash: crypto.createHash('sha1').update(fs.readFileSync(doc, 'utf8')).digest('hex').slice(0, 16),
          archivedAt: new Date().toISOString(),
          archivedPath: 'docs/archive/codex-completed/ALARM_INCIDENT_SUPERSEDED.md',
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        return { summary: { pass: false }, message: 'stale worker review failed' };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      shadow: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'completed_during_execution');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true' }));

  assert.strictEqual(
    alarms.some(alarm => alarm?.payload?.event_type === 'auto_dev_stage_failed'),
    false,
    'completed manifest must suppress stale stage-failed alarm',
  );
  assert.strictEqual(
    alarms.some(alarm => alarm?.eventType === 'auto_dev_alarm_repair_unresolved_needs_human'),
    false,
    'completed manifest must suppress stale unresolved alarm',
  );
  assert.ok(
    autoDevOutcomes.some(row => row.outcome === 'skipped' && row.stage === 'completed_during_execution'),
    'superseded worker should retain a non-failure audit outcome',
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed manifest suppresses in-flight stale failure alarms');
}

async function test_completed_manifest_suppresses_failure_at_notification_boundary() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_NOTIFICATION_RACE.md';
  const currentContent = '# Current incident\n';
  const currentContentHash = crypto.createHash('sha1').update(currentContent).digest('hex').slice(0, 16);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived',
        reason: 'auto_dev_current_state_resolved',
        implementationStatus: 'auto_dev_implementation_completed',
        contentHash: currentContentHash,
      },
    },
  }, null, 2), 'utf8');

  const { mocks, alarms } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const job = {
      relPath,
      contentHash: currentContentHash,
      analysis: {
        relPath,
        metadata: {
          source_team: 'blog',
          incident_key: 'blog:test:completed-notification-race',
          alarm_event_type: 'test_error',
        },
      },
    };
    const stageResult = await pipeline._testOnly_sendStageAlarm(
      job,
      'failed',
      'stale worker failed',
      { shadow: false, test: false },
    );
    const repairResult = await pipeline._testOnly_sendAlarmRepairResult(
      job,
      'unresolved_needs_human',
      'stale worker failed',
      { shadow: false, test: false },
      null,
      [
        '---',
        'source_team: blog',
        'incident_key: blog:test:completed-notification-race',
        'alarm_event_type: test_error',
        '---',
      ].join('\n'),
    );
    assert.strictEqual(stageResult.reason, 'completed_manifest');
    assert.strictEqual(repairResult.reason, 'completed_manifest');
  }, testEnv(tmpRoot));

  assert.strictEqual(alarms.length, 0, 'notification boundary must not emit completed-job failure alarms');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: notification boundary suppresses completed-manifest failure alarms');
}

async function test_alarm_repair_result_uses_callback_contract() {
  const tmpRoot = makeTempRoot();
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK.md';
  const contentHash = 'callback-contract-hash';
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    entries: {
      [relPath]: { relPath, state: 'archived', contentHash, reason: 'completed' },
    },
  }, null, 2), 'utf8');
  const { mocks, alarms, repairCallbacks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline._testOnly_sendAlarmRepairResult(
      {
        relPath,
        contentHash,
        analysis: {
          relPath,
          metadata: {
            source_team: 'reservation',
            incident_key: 'reservation:test:callback',
            alarm_event_id: '12345',
            alarm_event_type: 'test_error',
          },
        },
      },
      'resolved',
      'fixed and verified',
      { shadow: false, test: false },
      { changedFiles: ['bots/reservation/lib/pickko.ts'] },
      '',
    );
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot));

  assert.strictEqual(alarms.length, 0, 'repair results must not use generic /hub/alarm');
  assert.strictEqual(repairCallbacks.length, 1, 'repair result must use the callback contract once');
  assert.strictEqual(repairCallbacks[0].incidentKey, 'reservation:test:callback');
  assert.strictEqual(repairCallbacks[0].alarmEventId, '12345');
  assert.strictEqual(repairCallbacks[0].status, 'resolved');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: repair result uses Hub callback contract');
}

async function test_completed_alarm_callback_failure_is_retried_without_reimplementation() {
  const tmpRoot = makeTempRoot();
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK_RETRY.md';
  const doc = makeDoc(tmpRoot, 'ALARM_INCIDENT_CALLBACK_RETRY.md', [
    '---',
    'target_team: claude',
    'owner_agent: codex',
    'source_team: reservation',
    'source_bot: jimmy',
    'incident_key: reservation:test:callback-retry',
    'alarm_event_id: 54321',
    'alarm_event_type: reservation_error',
    'risk_tier: normal',
    'task_type: development_task',
    'write_scope:',
    '  - bots/claude/**',
    'test_scope:',
    '  - npm --prefix bots/claude run test:auto-dev',
    'autonomy_level: autonomous_l5',
    'requires_live_execution: false',
    '---',
    '',
    '# Callback delivery retry',
    '',
    'Implementation and verification are complete.',
  ].join('\n'));
  const callbackPayloads = [];
  let callbackIntentSnapshot = null;
  let callbackShouldFail = true;
  const { mocks } = makeMocks(tmpRoot, {
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async () => ({ ok: true }),
      postAlarmAutoRepairResult: async payload => {
        callbackPayloads.push(payload);
        callbackIntentSnapshot = JSON.parse(
          fs.readFileSync(path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'), 'utf8')
        ).entries[relPath];
        if (callbackShouldFail) {
          return {
            ok: false,
            error: 'hub callback unavailable',
            retryable: true,
            retryAfterMs: 2500,
          };
        }
        return { ok: true, eventId: 98765, mirrorUpdate: { ok: true, updated: 1 } };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      shadow: false,
      executeImplementation: false,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.implementationCompleted, true);
    assert.strictEqual(result.callbackPending, true);
    assert.strictEqual(callbackIntentSnapshot.callbackState, 'pending', 'callback intent must be durable before the HTTP call');
    assert.strictEqual(callbackIntentSnapshot.callbackAttempts, 0);
    assert.strictEqual(callbackIntentSnapshot.callbackPayload.alarmEventId, '54321');

    let manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'archived');
    assert.strictEqual(manifest.entries[relPath].callbackState, 'pending');
    assert.strictEqual(manifest.entries[relPath].callbackAttempts, 1);
    assert.strictEqual(manifest.entries[relPath].callbackPayload.alarmEventId, '54321');
    const callbackNextAttemptMs = Date.parse(manifest.entries[relPath].callbackNextAttemptAt);
    const callbackLastAttemptMs = Date.parse(manifest.entries[relPath].callbackLastAttemptAt);
    assert(Number.isFinite(callbackNextAttemptMs), 'initial callback failure must schedule a retry');
    assert.strictEqual(callbackNextAttemptMs - callbackLastAttemptMs, 2500, 'Hub retry-after must override the shorter local backoff');

    const deferredRetry = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({
      shadow: false,
      test: false,
      nowMs: callbackNextAttemptMs - 1,
    });
    assert.strictEqual(deferredRetry.attemptedCount, 0, 'callback must not retry before the scheduled time');
    assert.strictEqual(deferredRetry.deferredCount, 1);
    assert.strictEqual(callbackPayloads.length, 1);

    callbackShouldFail = false;
    const retry = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({
      shadow: false,
      test: false,
      nowMs: callbackNextAttemptMs,
    });
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.deliveredCount, 1);
    assert.strictEqual(retry.failedCount, 0);
    assert.strictEqual(callbackPayloads.length, 2, 'only the callback should be retried');

    manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'archived');
    assert.strictEqual(manifest.entries[relPath].callbackState, 'delivered');
    assert.strictEqual(manifest.entries[relPath].callbackAttempts, 2);
    assert.strictEqual(manifest.entries[relPath].callbackEventId, 98765);

    const noPendingRetry = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({ shadow: false, test: false });
    assert.strictEqual(noPendingRetry.pendingCount, 0);
    assert.strictEqual(callbackPayloads.length, 2, 'delivered callback must not be retried again');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_CALLBACK_RETRY_BASE_MS: '1000',
    CLAUDE_AUTO_DEV_CALLBACK_RETRY_MAX_MS: '4000',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed implementation retries only the failed Hub callback');
}

async function test_archived_missing_pending_callback_is_retried() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK_ARCHIVED_MISSING.md';
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    entries: {
      [relPath]: {
        relPath,
        state: 'archived_missing',
        contentHash: 'archived-missing-callback-hash',
        reason: 'completed',
        callbackState: 'pending',
        callbackAttempts: 1,
        callbackPayload: {
          incidentKey: 'reservation:test:archived-missing-callback',
          alarmEventId: 'archived-missing-generation',
          status: 'resolved',
        },
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const callbackPayloads = [];
  const { mocks } = makeMocks(tmpRoot, {
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async () => ({ ok: true }),
      postAlarmAutoRepairResult: async payload => {
        callbackPayloads.push(payload);
        return { ok: true, eventId: 90003, mirrorUpdate: { ok: true, updated: 1 } };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const retry = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({ shadow: false, test: false });
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.deliveredCount, 1);
    assert.strictEqual(callbackPayloads.length, 1);

    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].callbackState, 'delivered');
    assert.strictEqual(manifest.entries[relPath].state, 'archived_missing');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archived_missing pending callback remains retryable');
}

async function test_callback_retry_does_not_archive_regenerated_generation() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK_GENERATION.md';
  const oldHash = 'old-callback-hash';
  const newHash = 'new-callback-hash';
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    entries: {
      [relPath]: {
        relPath,
        state: 'archived',
        contentHash: oldHash,
        reason: 'completed',
        callbackState: 'pending',
        callbackAttempts: 1,
        callbackPayload: {
          incidentKey: 'reservation:test:generation',
          alarmEventId: 'old-generation',
          status: 'resolved',
        },
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot, {
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async () => ({ ok: true }),
      postAlarmAutoRepairResult: async () => {
        const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
        manifestLib.markAutoDevManifestState(autoDir, relPath, 'inbox', { contentHash: newHash });
        return { ok: true, eventId: 90001, mirrorUpdate: { ok: true, updated: 1 } };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const retry = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({ shadow: false, test: false });
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.results[0].superseded, true, 'old callback result must detect the new generation');
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'inbox', 'new generation must remain actionable');
    assert.strictEqual(manifest.entries[relPath].contentHash, newHash);
    assert.strictEqual(manifest.entries[relPath].callbackState, undefined);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: old callback cannot archive regenerated generation');
}

async function test_permanent_callback_failure_does_not_starve_following_entry() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const firstRelPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK_PERMANENT.md';
  const secondRelPath = 'docs/auto_dev/ALARM_INCIDENT_CALLBACK_FOLLOWING.md';
  fs.mkdirSync(autoDir, { recursive: true });
  const makeEntry = (relPath, alarmEventId, createdAt) => ({
    relPath,
    state: 'archived',
    contentHash: `${alarmEventId}-hash`,
    reason: 'completed',
    callbackState: 'pending',
    callbackAttempts: 1,
    callbackPayload: { incidentKey: `reservation:test:${alarmEventId}`, alarmEventId, status: 'resolved' },
    createdAt,
  });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    entries: {
      [firstRelPath]: makeEntry(firstRelPath, 'permanent-generation', '2026-07-18T00:00:00.000Z'),
      [secondRelPath]: makeEntry(secondRelPath, 'following-generation', '2026-07-18T00:01:00.000Z'),
    },
  }, null, 2), 'utf8');

  const attempted = [];
  const { mocks } = makeMocks(tmpRoot, {
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async () => ({ ok: true }),
      postAlarmAutoRepairResult: async payload => {
        attempted.push(payload.alarmEventId);
        if (payload.alarmEventId === 'permanent-generation') {
          return { ok: false, status: 409, retryable: false, error: 'hub_alarm_mirror_generation_not_found' };
        }
        return { ok: true, eventId: 90002, mirrorUpdate: { ok: true, updated: 1 } };
      },
    },
  });

  await withMocks(mocks, async pipeline => {
    const first = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({
      shadow: false,
      test: false,
      callbackBatchLimit: 1,
    });
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.results[0].terminal, true);

    const second = await pipeline._testOnly_retryPendingAlarmRepairCallbacks({
      shadow: false,
      test: false,
      callbackBatchLimit: 1,
    });
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(attempted, ['permanent-generation', 'following-generation']);

    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[firstRelPath].callbackState, 'manual_required');
    assert.strictEqual(manifest.entries[secondRelPath].callbackState, 'delivered');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: permanent callback failure cannot starve following callbacks');
}

async function test_callback_retry_exception_releases_global_lock() {
  const tmpRoot = makeTempRoot();
  const lockPath = path.join(tmpRoot, 'claude-auto-dev.lock');
  const manifestLib = require(AUTO_DEV_MANIFEST_PATH);
  const { mocks } = makeMocks(tmpRoot, {
    '../../../packages/core/lib/auto-dev-manifest.ts': {
      ...manifestLib,
      loadAutoDevManifest: () => { throw new Error('manifest_retry_read_failed'); },
    },
  });

  await withMocks(mocks, async pipeline => {
    await assert.rejects(
      () => pipeline.runAutoDevPipeline({ force: true, test: false, shadow: false, once: true }),
      /manifest_retry_read_failed/,
    );
    assert.strictEqual(fs.existsSync(lockPath), false, 'callback retry failure must release the global lock');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: callback retry exception releases global lock');
}

async function test_regenerated_incident_with_same_path_keeps_failure_alarm() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_REGENERATED.md';
  const oldContentHash = crypto.createHash('sha1').update('# Old incident\n').digest('hex').slice(0, 16);
  const newContentHash = crypto.createHash('sha1').update('# New incident\n').digest('hex').slice(0, 16);
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived',
        reason: 'auto_dev_current_state_resolved',
        implementationStatus: 'auto_dev_implementation_completed',
        contentHash: oldContentHash,
      },
    },
  }, null, 2), 'utf8');

  const { mocks, alarms } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const job = {
      relPath,
      contentHash: newContentHash,
      analysis: { relPath },
    };
    const result = await pipeline._testOnly_sendStageAlarm(
      job,
      'failed',
      'new incident failed',
      { shadow: false, test: false },
    );
    assert.notStrictEqual(result?.reason, 'completed_manifest');
  }, testEnv(tmpRoot));

  assert.strictEqual(alarms.length, 1, 'new content at a reused path must retain its failure alarm');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: regenerated same-path incidents retain failure alarms');
}

async function test_archived_missing_without_completed_history_requeues() {
  const tmpRoot = makeTempRoot();
  const autoDir = path.join(tmpRoot, 'docs', 'auto_dev');
  fs.mkdirSync(autoDir, { recursive: true });
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_requeue.md';
  fs.writeFileSync(path.join(tmpRoot, relPath), withRequiredMetadata('# Requeue'), 'utf8');
  fs.writeFileSync(path.join(autoDir, '.auto-dev-manifest.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {
      [relPath]: {
        relPath,
        state: 'archived_missing',
        archivedAt: '2026-06-03T00:00:00.000Z',
        archivedBy: 'auto-dev-pipeline',
        archivedPath: 'docs/archive/codex-completed/ALARM_INCIDENT_requeue.done.md',
        createdAt: '2026-06-03T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const docs = pipeline.listAutoDevDocuments().map(file => path.relative(tmpRoot, file).replace(/\\/g, '/'));
    assert.deepStrictEqual(docs, [relPath]);
    const manifest = JSON.parse(fs.readFileSync(path.join(autoDir, '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'inbox');
    assert.strictEqual(manifest.entries[relPath].source, 'requeued_missing_archive');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archived_missing without completed history requeues');
}

async function test_auto_dev_watch_passes_state_file_to_manifest_sync() {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/auto-dev-watch.ts'), 'utf8');
  assert.match(source, /const STATE_FILE = process\.env\.CLAUDE_AUTO_DEV_STATE_FILE/);
  assert.match(source, /const manifestOptions = \{ autoDevStateFile: STATE_FILE \};/);
  assert.match(source, /syncAutoDevManifest\(AUTO_DEV_DIR, manifestOptions\);/);
  assert.match(source, /listAutoDevManifestEntries\(AUTO_DEV_DIR, \['inbox'\], manifestOptions\)/);
  console.log('✅ auto-dev: watch path passes state file to manifest sync');
}

async function test_missing_auto_dev_document_is_skipped() {
  const tmpRoot = makeTempRoot();
  const missingDoc = path.join(tmpRoot, 'docs', 'auto_dev', 'ALARM_INCIDENT_missing.md');

  const { mocks, alarms, autoDevOutcomes } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(missingDoc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'skipped_missing_doc');
    assert.strictEqual(result.job?.stage, 'skipped_missing_doc');
  }, testEnv(tmpRoot));
  assert.strictEqual(alarms.length, 0);
  assert.strictEqual(autoDevOutcomes.length, 1);
  assert.strictEqual(autoDevOutcomes[0].outcome, 'skipped_missing_doc');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: missing docs are skipped without fatal error');
}

async function test_missing_auto_dev_document_after_listing_is_skipped() {
  const tmpRoot = makeTempRoot();
  const missingDoc = path.join(tmpRoot, 'docs', 'auto_dev', 'ALARM_INCIDENT_raced.md');
  const relPath = path.relative(tmpRoot, missingDoc).replace(/\\/g, '/');
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      raced: {
        id: 'raced',
        relPath,
        contentHash: 'old-content-hash',
        status: 'running',
        stage: 'implementation',
        updatedAt: new Date().toISOString(),
      },
    },
  }), 'utf8');
  const enoent = new Error(`ENOENT: no such file or directory, open '${missingDoc}'`);
  enoent.code = 'ENOENT';
  const fsMock = {
    ...fs,
    existsSync: filePath => (filePath === missingDoc ? true : fs.existsSync(filePath)),
    readFileSync: (filePath, ...args) => {
      if (filePath === missingDoc) throw enoent;
      return fs.readFileSync(filePath, ...args);
    },
  };

  const { mocks, alarms, autoDevOutcomes } = makeMocks(tmpRoot, { fs: fsMock });
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(missingDoc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'skipped_missing_doc');
    assert.strictEqual(result.job?.stage, 'skipped_missing_doc');
    const state = pipeline.loadState();
    assert.strictEqual(state.jobs.raced.status, 'skipped');
    assert.strictEqual(state.jobs.raced.stage, 'skipped_missing_doc');
  }, testEnv(tmpRoot));
  assert.strictEqual(alarms.length, 0);
  assert.strictEqual(autoDevOutcomes.length, 1);
  assert.strictEqual(autoDevOutcomes[0].outcome, 'skipped_missing_doc');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: docs removed after listing are skipped without fatal error');
}

async function test_success_only_blog_engagement_alarm_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_blog_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: blog alarm',
        '',
        '## Incident',
        '- from_bot: blog-neighbor-commenter',
        '',
        '## Error Message',
        '```text',
        '이웃 댓글 2건 완료, 댓글 공감 2건 완료, 실패 0건, 스킵 0건 (오늘 댓글 총 4/20, 댓글공감 총 4)',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'blog',
        source_bot: 'blog-neighbor-commenter',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: success-only blog engagement alarms are skipped');
}

async function test_reservation_booking_alert_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_reservation_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: reservation alarm',
        '',
        '## Incident',
        '- from_bot: andy',
        '- incident_key: reservation:andy:alert:sample1234',
        '',
        '## Error Message',
        '```text',
        '🆕 신규 예약 감지!',
        '──────────',
        '👤 고객: 홍길동',
        '📅 날짜: 2026-05-03',
        '⏰ 시간: 16:00~18:00',
        '📊 상태: pending',
        '──────────',
        '✅ 조치: Pickko 자동 등록 준비 중...',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'reservation',
        source_bot: 'andy',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: reservation booking alerts are skipped');
}

async function test_reservation_cancel_blocked_alert_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_reservation_cancel_blocked.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: reservation alarm',
        '',
        '## Incident',
        '- from_bot: andy',
        '- incident_key: reservation:andy:alert:sample5678',
        '',
        '## Error Message',
        '```text',
        '🛡️ 픽코 자동 취소 차단',
        '──────────',
        '📞 번호: 010-3274-7970',
        '📅 날짜: 2026-06-14',
        '⏰ 시간: 11:00~12:00',
        '🏛️ 룸: A1',
        'ℹ️ 사유: PICKKO_CANCEL_MUTATION_ENABLE!=1',
        '──────────',
        '✅ 조치: 네이버 취소 감지는 됐지만 픽코 실제 취소는 차단되어 수동 확인이 필요합니다.',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'reservation',
        source_bot: 'andy',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: reservation cancel-blocked alerts are skipped');
}

async function test_ops_emergency_telegram_snapshot_is_skipped() {
  for (const [name, finalError] of [
    ['provider-circuit', 'provider_circuit_open:openai-oauth'],
    ['provider-timeout', 'timeout (10000ms)'],
  ]) {
    const tmpRoot = makeTempRoot();
    const doc = makeDoc(
      tmpRoot,
      `ALARM_INCIDENT_ops-emergency_${name}.md`,
      withRequiredMetadata(
        [
          '# Alarm Incident Auto-Repair: ops-emergency alarm',
          '',
          '## Incident',
          '- from_bot: telegram-sender',
          '- incident_key: ops-emergency:telegram-sender:telegram_critical:sample1234',
          '',
          '## Error Message',
          '```text',
          '🚨 [general] CRITICAL',
          '🚨 Fallback Exhaustion',
          '팀: luna / 에이전트: luna',
          '시도: openai-oauth/gpt-5.4',
          `최종 에러: ${finalError}`,
          '```',
        ].join('\n'),
        {
          target_team: 'claude',
          source_team: 'ops-emergency',
          source_bot: 'telegram-sender',
          risk_tier: 'high',
          task_type: 'development_task',
        },
      ),
    );

    const { mocks } = makeMocks(tmpRoot);
    await withMocks(mocks, async pipeline => {
      const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, 'implementation_completed');
      assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
    }, testEnv(tmpRoot));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('✅ auto-dev: ops-emergency telegram fallback snapshots are skipped');
}

async function test_investment_position_watch_alert_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_investment_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: investment alarm',
        '',
        '## Incident',
        '- from_bot: luna-position-watch',
        '- incident_key: investment:luna-position-watch:alert:sample1234',
        '',
        '## Error Message',
        '```text',
        '👀 포지션 watch',
        'status: position_runtime_attention',
        'positions: 2 | fast-lane 2 | HOLD 0 / ADJUST 1 / EXIT 1',
        'autopilot: position_runtime_autopilot_ready',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'investment',
        source_bot: 'luna-position-watch',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: investment position watch alerts are skipped');
}

async function test_claude_health_snapshot_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_claude_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: claude alarm',
        '',
        '## Incident',
        '- from_bot: claude',
        '- incident_key: claude:claude:health_check:sample1234',
        '',
        '## Error Message',
        '```text',
        '🔴 [점검] [클로드 헬스] auto-dev.autonomous 다운',
        'PID 없음 — launchd 재시작 실패 가능성',
        'event_type: health_check',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'claude',
        source_bot: 'claude',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: claude health snapshots are skipped');
}

async function test_blog_instagram_snapshot_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_blog_instagram_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: blog alarm',
        '',
        '## Incident',
        '- from_bot: unknown',
        '- incident_key: blog:unknown:unknown_error:sample1234',
        '',
        '## Error Message',
        '```text',
        '[블로팀] 인스타 일일 현황',
        '성공: 0건 | 실패: 5건 | 생략: 0건',
        '성공률: 0%',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'blog',
        source_bot: 'unknown',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: blog instagram snapshots are skipped');
}

async function test_auto_dev_self_alarm_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_auto_dev_self_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: claude alarm',
        '',
        '## Incident',
        '- from_bot: auto-dev',
        '- incident_key: claude:auto-dev:auto_dev_stage_plan:sample1234',
        '',
        '## Error Message',
        '```text',
        '🤖 클로드팀 auto_dev — 구현계획 수립',
        'event_type: auto_dev_stage_plan',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'claude',
        source_bot: 'auto-dev',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: auto-dev self alarms are skipped');
}

async function test_blog_health_recovery_snapshot_is_skipped() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'ALARM_INCIDENT_blog_health_recovery_sample.md',
    withRequiredMetadata(
      [
        '# Alarm Incident Auto-Repair: blog alarm',
        '',
        '## Incident',
        '- from_bot: blog-health',
        '- incident_key: blog:blog-health:blog_health_check:sample5678',
        '',
        '## Error Message',
        '```text',
        '✅ [블로그 헬스] engagement 자동화 회복',
        'engagement failures present but non-UI (2건)',
        '```',
      ].join('\n'),
      {
        target_team: 'claude',
        source_team: 'blog',
        source_bot: 'blog-health',
        risk_tier: 'medium',
        task_type: 'development_task',
      },
    ),
  );

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, { shadow: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(result.job?.policyDecision, 'non_actionable_alarm_snapshot');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: blog health recovery snapshots are skipped');
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
  const { mocks, alarms, autoDevOutcomes } = makeMocks(tmpRoot);
  const originalDateNow = Date.now;
  let fakeNow = 1_000_000;

  try {
    Date.now = () => {
      fakeNow += 25;
      return fakeNow;
    };
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
  } finally {
    Date.now = originalDateNow;
  }

  assert.strictEqual(alarms.length, 0, 'test 모드는 실제 알림 대신 shadow');
  assert.strictEqual(autoDevOutcomes.length, 1);
  assert.strictEqual(autoDevOutcomes[0].outcome, 'completed');
  assert.strictEqual(autoDevOutcomes[0].stage, 'completed');
  assert.strictEqual(autoDevOutcomes[0].test_pass, true);
  assert.ok(autoDevOutcomes[0].duration_ms > 0);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: processes dry pipeline to completion');
}

async function test_auto_dev_failed_outcome_masks_secrets() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_SECRET_FAIL.md', '# Fail\nx');
  const { mocks, autoDevOutcomes } = makeMocks(tmpRoot, {
    '../src/reviewer.ts': {
      runReview: async () => ({
        summary: { pass: false },
        message: 'review failed api_key=fixture-secret-value password=plain-secret',
      }),
    },
  });
  const originalDateNow = Date.now;
  let fakeNow = 2_000_000;

  try {
    Date.now = () => {
      fakeNow += 25;
      return fakeNow;
    };
    await withMocks(mocks, async pipeline => {
      const result = await pipeline.processAutoDevDocument(doc, {
        test: true,
        force: true,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.job.status, 'failed');
    }, testEnv(tmpRoot));
  } finally {
    Date.now = originalDateNow;
  }

  assert.strictEqual(autoDevOutcomes.length, 1);
  assert.strictEqual(autoDevOutcomes[0].outcome, 'failed');
  assert.strictEqual(autoDevOutcomes[0].stage, 'failed');
  assert.ok(autoDevOutcomes[0].duration_ms > 0);
  assert.ok(!autoDevOutcomes[0].error_summary.includes('fixture-secret-value'));
  assert.ok(!autoDevOutcomes[0].error_summary.includes('plain-secret'));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: failed outcome masks sensitive error summaries');
}

async function test_failure_circuit_breaker_dead_letters_once_and_allows_new_hash() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CIRCUIT_BREAKER.md', '# Circuit\nfail until deferred');
  const originalContent = fs.readFileSync(doc, 'utf8');
  const { mocks, alarms } = makeMocks(tmpRoot, {
    '../src/reviewer.ts': {
      runReview: async () => ({ summary: { pass: false }, message: 'fixture review failure' }),
    },
  });

  await withMocks(mocks, async pipeline => {
    const options = {
      force: true,
      test: false,
      dryRun: true,
      shadow: false,
      maxRevisionPasses: 0,
    };
    const first = await pipeline.processAutoDevDocument(doc, options);
    const second = await pipeline.processAutoDevDocument(doc, options);
    const third = await pipeline.processAutoDevDocument(doc, options);

    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.job.failureAttempts, 1);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.job.failureAttempts, 2);
    assert.strictEqual(third.ok, true);
    assert.strictEqual(third.skipped, true);
    assert.strictEqual(third.reason, 'dead_letter');
    assert.strictEqual(third.job.status, 'dead_letter');
    assert.strictEqual(third.job.failureAttempts, 3);
    assert.ok(third.job.deadLetteredAt);
    assert.ok(fs.existsSync(path.join(tmpRoot, third.job.processedPath)));
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'), 'utf8'));
    const manifestEntry = manifest.entries['docs/auto_dev/CODEX_CIRCUIT_BREAKER.md'];
    assert.strictEqual(manifestEntry.processedPath, third.job.processedPath);
    assert.strictEqual(fs.existsSync(doc), false);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tmpRoot, 'auto-dev-state.json'), 'utf8')));

    fs.writeFileSync(doc, originalContent, 'utf8');
    assert.deepStrictEqual(pipeline.listAutoDevDocuments(), []);
    assert.strictEqual(fs.existsSync(doc), false);

    fs.writeFileSync(doc, originalContent, 'utf8');
    const sameHash = await pipeline.processAutoDevDocument(doc, options);
    assert.strictEqual(sameHash.ok, true);
    assert.strictEqual(sameHash.skipped, true);
    assert.strictEqual(sameHash.reason, 'dead_letter_same_content');
    assert.strictEqual(fs.existsSync(doc), false);

    fs.writeFileSync(doc, `${originalContent}\nnew requirement`, 'utf8');
    assert.deepStrictEqual(pipeline.listAutoDevDocuments(), [doc]);
    const newHash = await pipeline.processAutoDevDocument(doc, options);
    assert.strictEqual(newHash.ok, false);
    assert.notStrictEqual(newHash.job.id, third.job.id);
    assert.strictEqual(newHash.job.failureAttempts, 1);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_MAX_ATTEMPTS: '3',
  }));

  const deadLetterAlarms = alarms.filter(alarm => alarm.eventType === 'auto_dev_dead_letter');
  assert.strictEqual(deadLetterAlarms.length, 1, 'dead-letter master alarm must be emitted once per content hash');
  assert.strictEqual(
    alarms.filter(alarm => alarm.alertLevel === 3).length,
    1,
    'retryable failures must not emit duplicate master error alarms before dead-letter',
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: failure circuit breaker dead-letters once and allows new content hash');
}

async function test_dead_letter_move_failure_stays_terminal() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_MOVE_FAILURE.md', '# Move\nfail safely');
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  let observedTerminalStateBeforeMove = false;
  const fsMock = {
    ...fs,
    copyFileSync: (source, destination, flags) => {
      if (String(destination).includes(`${path.sep}processed${path.sep}`)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        observedTerminalStateBeforeMove = Object.values(state.jobs || {})
          .some(job => job.status === 'dead_letter');
        const error = new Error('fixture processed directory is read-only');
        error.code = 'EACCES';
        throw error;
      }
      return fs.copyFileSync(source, destination, flags);
    },
  };
  const { mocks, alarms } = makeMocks(tmpRoot, {
    fs: fsMock,
    '../src/reviewer.ts': {
      runReview: async () => ({ summary: { pass: false }, message: 'fixture review failure' }),
    },
  });

  await withMocks(mocks, async pipeline => {
    const options = { force: true, test: false, dryRun: true, shadow: false, maxRevisionPasses: 0 };
    const terminal = await pipeline.processAutoDevDocument(doc, options);
    assert.strictEqual(terminal.reason, 'dead_letter');
    assert.strictEqual(terminal.job.status, 'dead_letter');
    assert.strictEqual(terminal.job.processedMove.ok, false);
    assert.strictEqual(terminal.job.processedMove.reason, 'processed_move_failed');
    assert.strictEqual(observedTerminalStateBeforeMove, true);
    assert.strictEqual(fs.existsSync(doc), true);
    assert.deepStrictEqual(pipeline.listAutoDevDocuments(), []);

    const duplicate = await pipeline.processAutoDevDocument(doc, options);
    assert.strictEqual(duplicate.reason, 'dead_letter_same_content');
    assert.strictEqual(duplicate.job.status, 'dead_letter');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_MAX_ATTEMPTS: '1',
  }));

  assert.strictEqual(alarms.filter(alarm => alarm.eventType === 'auto_dev_dead_letter').length, 1);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: processed move failure cannot reopen a dead-lettered job');
}

async function test_record_outcome_accepts_refactor_meta_tags() {
  const tmpRoot = makeTempRoot();
  const { mocks, autoDevOutcomes } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.recordAutoDevOutcome({
      id: 'refactor-cycle-fixture',
      relPath: 'docs/codex/refactor-plans/REFACTOR_fixture.md',
      stage: 'refactor_shadow_plan',
      profile: 'refactor-shadow',
      targetTeam: 'claude',
      writeScope: ['bots/claude/lib/agent-heartbeat.ts'],
      riskTier: 'normal',
    }, 'completed', {
      kind: 'refactor',
      refactorType: 'ts_nocheck',
      cycleId: 'refactor-fixture',
      source: 'claude-refactorer',
      meta: {
        mode: 'shadow',
        phase: 'phase1',
      },
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot));

  assert.strictEqual(autoDevOutcomes.length, 1);
  const meta = JSON.parse(autoDevOutcomes[0].meta);
  assert.strictEqual(meta.kind, 'refactor');
  assert.strictEqual(meta.refactorType, 'ts_nocheck');
  assert.strictEqual(meta.cycleId, 'refactor-fixture');
  assert.strictEqual(meta.source, 'claude-refactorer');
  assert.strictEqual(meta.mode, 'shadow');
  assert.strictEqual(meta.phase, 'phase1');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: outcome meta supports refactor tags without schema change');
}

async function test_record_outcome_normalizes_error_summary_and_keeps_raw_meta() {
  const tmpRoot = makeTempRoot();
  const { mocks, autoDevOutcomes } = makeMocks(tmpRoot);
  const fixtures = [
    ['tests_failed', 'Tests failed: 2 suites\nfull test output'],
    ['test_revision_failed', 'test_revision_failed: retry still red\nrevision diff'],
    ['enoent', 'ENOENT: no such file or directory, open /tmp/missing'],
    ['cli_unavailable', 'codex_cli_unavailable: codex command not found'],
    ['review_failed', 'review failed api_key=fixture-secret-value\nreview log'],
    ['usage_limit', 'You have hit your usage limit for this billing period'],
    ['other', 'unexpected implementation failure\nraw details'],
  ];

  await withMocks(mocks, async pipeline => {
    for (const [tag, raw] of fixtures) {
      const result = await pipeline.recordAutoDevOutcome({
        id: `error-${tag}`,
        relPath: `docs/auto_dev/${tag}.md`,
        stage: 'failed',
      }, 'failed', { errorSummary: raw });
      assert.strictEqual(result.ok, true);
    }
  }, testEnv(tmpRoot));

  assert.strictEqual(autoDevOutcomes.length, fixtures.length);
  fixtures.forEach(([tag], index) => {
    const row = autoDevOutcomes[index];
    assert.match(row.error_summary, new RegExp(`^${tag}: `));
    assert.equal(row.error_summary.includes('\n'), false);
    const meta = JSON.parse(row.meta);
    assert.strictEqual(meta.error.tag, tag);
    assert.ok(meta.error.raw.length > 0);
  });
  assert.ok(!JSON.parse(autoDevOutcomes[4].meta).error.raw.includes('fixture-secret-value'));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: normalizes error summaries and keeps masked raw details in meta');
}

async function test_stale_running_job_retries_with_recovery_count() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_STALE_RETRY.md', '# Stale\nretry');
  const content = fs.readFileSync(doc, 'utf8');
  const jobId = computeJobId(tmpRoot, doc, content);
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      [jobId]: {
        id: jobId,
        relPath: 'docs/auto_dev/CODEX_STALE_RETRY.md',
        status: 'running',
        stage: 'implementation',
        staleRecoveryCount: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      shadow: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.job.status, 'completed');
    assert.strictEqual(result.job.staleRecoveryCount, 2);
    assert.ok(
      result.job.events.some(event => event.type === 'recovered_stale_running_job' && event.staleRecoveryCount === 2),
      'stale recovery event should include incremented count'
    );
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
    CLAUDE_AUTO_DEV_MAX_STALE_RECOVERY: '3',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: stale running job retries with recovery count');
}

async function test_stale_running_job_blocks_after_recovery_exhaustion() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_STALE_EXHAUSTED.md', '# Stale\nexhausted');
  const content = fs.readFileSync(doc, 'utf8');
  const relPath = 'docs/auto_dev/CODEX_STALE_EXHAUSTED.md';
  const jobId = computeJobId(tmpRoot, doc, content);
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      [jobId]: {
        id: jobId,
        relPath,
        status: 'running',
        stage: 'implementation',
        staleRecoveryCount: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      shadow: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'stale_recovery_exhausted');
    assert.strictEqual(result.job.status, 'blocked');
    assert.strictEqual(result.job.stage, 'stale_recovery_exhausted');
    assert.strictEqual(result.job.staleRecoveryCount, 4);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.entries[relPath].state, 'failed');
    assert.strictEqual(manifest.entries[relPath].reason, 'stale_recovery_exhausted');
    assert.strictEqual(manifest.entries[relPath].staleRecoveryCount, 4);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
    CLAUDE_AUTO_DEV_MAX_STALE_RECOVERY: '3',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: stale running job blocks after recovery exhaustion');
}

async function test_invalid_stale_recovery_env_falls_back_to_default_limit() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_STALE_INVALID_ENV.md', '# Stale\ninvalid env');
  const content = fs.readFileSync(doc, 'utf8');
  const relPath = 'docs/auto_dev/CODEX_STALE_INVALID_ENV.md';
  const jobId = computeJobId(tmpRoot, doc, content);
  const statePath = path.join(tmpRoot, 'auto-dev-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    jobs: {
      [jobId]: {
        id: jobId,
        relPath,
        status: 'running',
        stage: 'implementation',
        staleRecoveryCount: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2), 'utf8');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: true,
      shadow: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'stale_recovery_exhausted');
    assert.strictEqual(result.job.maxStaleRecovery, 3);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
    CLAUDE_AUTO_DEV_MAX_STALE_RECOVERY: 'not-a-number',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: invalid stale recovery env falls back to default limit');
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
    assert.match(content, /implementation_model_provider:\s*`openai-oauth`/);
    assert.match(content, /implementation_model:\s*`openai-oauth\/gpt-5\.4`/);
    assert.match(content, /implementation_cli_model_arg:\s*`gpt-5\.4`/);
    assert.match(content, /implementation_model_source:\s*`profile`/);
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

async function test_implementation_completed_alarm_emits_resolved_callback() {
  const tmpRoot = makeTempRoot();
  const relPath = 'docs/auto_dev/ALARM_INCIDENT_REVIEWER_COMPLETED.md';
  const doc = makeDoc(tmpRoot, 'ALARM_INCIDENT_REVIEWER_COMPLETED.md', [
    '---',
    'target_team: claude',
    'owner_agent: codex',
    'source_team: claude',
    'source_bot: reviewer',
    'incident_key: claude:reviewer:reviewer_error:test-generation',
    'alarm_event_id: 12345',
    'alarm_event_type: reviewer_error',
    'risk_tier: normal',
    'task_type: development_task',
    'implementation_status: auto_dev_implementation_completed',
    'write_scope:',
    '  - bots/claude/**',
    'test_scope:',
    '  - npm --prefix bots/claude run test:auto-dev',
    'autonomy_level: supervised_l4',
    'requires_live_execution: false',
    '---',
    '',
    '# Completed reviewer repair',
    '<!-- auto_dev:implementation_completed -->',
  ].join('\n'));
  const { mocks, repairCallbacks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      test: false,
      force: true,
      shadow: false,
      executeImplementation: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'implementation_completed');
    assert.strictEqual(repairCallbacks.length, 1, 'completed alarm generation must emit one resolved callback');
    assert.strictEqual(repairCallbacks[0].incidentKey, 'claude:reviewer:reviewer_error:test-generation');
    assert.strictEqual(repairCallbacks[0].alarmEventId, '12345');
    assert.strictEqual(repairCallbacks[0].status, 'resolved');

    const manifest = JSON.parse(fs.readFileSync(
      path.join(tmpRoot, 'docs', 'auto_dev', '.auto-dev-manifest.json'),
      'utf8',
    ));
    assert.strictEqual(manifest.entries[relPath].state, 'archived');
    assert.strictEqual(manifest.entries[relPath].callbackState, 'delivered');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: completed alarm marker closes its exact Hub generation');
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
  let codexCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    '../src/reviewer.ts': {
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
        if (String(command).endsWith('/codex') || command === 'codex') {
          codexCalls += 1;
          return 'ok';
        }
        if (command === 'claude') throw new Error('claude CLI should not be used for default OpenAI OAuth auto-dev');
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
    assert.strictEqual(codexCalls, 2, 'initial implementation + revise_after_review');
  }, testEnv(tmpRoot, { CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true' }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: review failure triggers single revise_after_review loop');
}

async function test_test_failure_triggers_single_revise_loop() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_TEST_REVISE.md', '# A\nx');
  let buildCalls = 0;
  let codexCalls = 0;

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
        if (String(command).endsWith('/codex') || command === 'codex') {
          codexCalls += 1;
          return 'ok';
        }
        if (command === 'claude') throw new Error('claude CLI should not be used for default OpenAI OAuth auto-dev');
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
    assert.strictEqual(codexCalls, 2, 'initial implementation + revise_after_test');
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
    '../src/reviewer.ts': {
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
  assert.match(plist, /<key>CLAUDE_AUTO_DEV_DISABLED<\/key>\s*<string>true<\/string>/);
  assert.match(shadowPlist, /<key>CLAUDE_AUTO_DEV_DISABLED<\/key>\s*<string>true<\/string>/);
  assert.match(autonomousPlist, /<key>CLAUDE_AUTO_DEV_DISABLED<\/key>\s*<string>false<\/string>/);
  assert.match(autonomousPlist, /<key>CLAUDE_AUTO_DEV_MODEL<\/key>\s*<string>openai-oauth\/gpt-5\.4<\/string>/);
  assert.match(autonomousPlist, /<key>CLAUDE_AUTO_DEV_CODEX_CLI<\/key>/);
  assert.match(autonomousPlist, /<key>CLAUDE_AUTO_DEV_CODEX_CLI<\/key>\s*<string>codex<\/string>/);
  assert.doesNotMatch(shadowPlist, /CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION/);
  assert.doesNotMatch(autonomousPlist, /CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  console.log('✅ auto-dev: launchd plist safe defaults verified');
}

async function test_codex_cli_path_precedence_and_fallback_chain() {
  const tmpRoot = makeTempRoot();
  const configuredCli = path.join(tmpRoot, 'bin', 'codex-pinned');
  fs.mkdirSync(path.dirname(configuredCli), { recursive: true });
  fs.writeFileSync(configuredCli, '#!/bin/sh\n', 'utf8');
  fs.chmodSync(configuredCli, 0o755);
  const { mocks } = makeMocks(tmpRoot);
  const originalExecFileSync = mocks['child_process'].execFileSync;
  mocks['child_process'].execFileSync = (command, args = [], options = {}) => {
    if (command === 'bash' && String(args[1] || '').includes('codex-wrapper')) {
      return '/usr/local/bin/codex-wrapper\n';
    }
    if (command === 'bash' && args[1] === 'command -v codex') return '/opt/homebrew/bin/codex\n';
    if (command === configuredCli || command === 'codex') return 'ok';
    return originalExecFileSync(command, args, options);
  };

  await withMocks(mocks, async pipeline => {
    const configured = pipeline._testOnly_resolveCodexCliCommand();
    assert.deepStrictEqual(configured, {
      ok: true,
      command: configuredCli,
      source: 'CODEX_CLI_PATH',
    });
    const execution = pipeline._testOnly_runCodexImplementation('test prompt', {
      cliModelArg: 'gpt-5.4',
    }, {}, tmpRoot);
    assert.strictEqual(execution.pass, true);
    assert.strictEqual(execution.cli, configuredCli);
  }, testEnv(tmpRoot, {
    CODEX_CLI_PATH: configuredCli,
    CLAUDE_AUTO_DEV_CODEX_CLI: '',
    CODEX_CLI: '',
  }));

  fs.rmSync(configuredCli, { force: true });
  await withMocks(mocks, async pipeline => {
    const fallback = pipeline._testOnly_resolveCodexCliCommand();
    assert.deepStrictEqual(fallback, {
      ok: true,
      command: 'codex',
      resolvedPath: '/opt/homebrew/bin/codex',
      source: 'PATH',
      warning: `CODEX_CLI_PATH를 찾지 못해 PATH의 codex를 사용합니다: ${configuredCli}`,
    });
  }, testEnv(tmpRoot, {
    CODEX_CLI_PATH: configuredCli,
    CLAUDE_AUTO_DEV_CODEX_CLI: '',
    CODEX_CLI: '',
  }));

  await withMocks(mocks, async pipeline => {
    assert.deepStrictEqual(pipeline._testOnly_resolveCodexCliCommand(), {
      ok: true,
      command: 'codex-wrapper',
      resolvedPath: '/usr/local/bin/codex-wrapper',
      source: 'PATH',
    });
  }, testEnv(tmpRoot, {
    CODEX_CLI_PATH: '',
    CLAUDE_AUTO_DEV_CODEX_CLI: 'codex-wrapper',
    CODEX_CLI: '',
  }));

  const legacyPath = '/Applications/Codex.app/Contents/Resources/codex';
  const legacyFsMock = {
    ...fs,
    existsSync: filePath => (filePath === legacyPath ? true : fs.existsSync(filePath)),
    statSync: filePath => (filePath === legacyPath ? { isFile: () => true } : fs.statSync(filePath)),
    accessSync: filePath => (filePath === legacyPath ? undefined : fs.accessSync(filePath, fs.constants.X_OK)),
  };
  const { mocks: legacyMocks } = makeMocks(tmpRoot, { fs: legacyFsMock });
  legacyMocks['child_process'].execFileSync = (command, args = []) => {
    if (command === 'bash' && args[1] === 'command -v codex') throw new Error('codex not found');
    return '';
  };
  await withMocks(legacyMocks, async pipeline => {
    assert.deepStrictEqual(pipeline._testOnly_resolveCodexCliCommand(), {
      ok: true,
      command: legacyPath,
      source: 'legacy_path',
    });
  }, testEnv(tmpRoot, {
    CODEX_CLI_PATH: '',
    CLAUDE_AUTO_DEV_CODEX_CLI: '',
    CODEX_CLI: '',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: Codex CLI resolves CODEX_CLI_PATH before PATH fallback');
}

async function test_codex_cli_unavailable_is_non_retryable_and_trips_breaker() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_NO_CLI.md', '# CLI\nunavailable');
  const legacyPath = '/Applications/Codex.app/Contents/Resources/codex';
  const missingConfiguredPath = path.join(tmpRoot, 'missing', 'codex');
  const fsMock = {
    ...fs,
    existsSync: filePath => (filePath === legacyPath ? false : fs.existsSync(filePath)),
  };
  const { mocks, alarms } = makeMocks(tmpRoot, { fs: fsMock });
  mocks['child_process'].execFileSync = (command, args = []) => {
    if (command === 'bash' && args[1] === 'command -v codex') throw new Error('codex not found');
    if (command === 'rg') throw new Error('no match');
    return '';
  };

  await withMocks(mocks, async pipeline => {
    const resolution = pipeline._testOnly_resolveCodexCliCommand();
    assert.strictEqual(resolution.ok, false);
    assert.strictEqual(resolution.reason, 'codex_cli_unavailable');
    assert.strictEqual(resolution.nonRetryable, true);

    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      shadow: false,
      executeImplementation: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'dead_letter');
    assert.strictEqual(result.job.status, 'dead_letter');
    assert.strictEqual(result.job.failureAttempts, 1);
    assert.strictEqual(result.job.nonRetryableReason, 'codex_cli_unavailable');
    assert.ok(result.job.failedAt);
    assert.ok(result.job.deadLetteredAt);
  }, testEnv(tmpRoot, {
    CODEX_CLI_PATH: missingConfiguredPath,
    CLAUDE_AUTO_DEV_CODEX_CLI: '',
    CODEX_CLI: '',
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.strictEqual(alarms.filter(alarm => alarm.eventType === 'auto_dev_dead_letter').length, 1);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: missing Codex CLI trips non-retryable breaker immediately');
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
    assert.strictEqual(shadow.implementationProvider, 'openai-oauth');
    assert.strictEqual(shadow.implementationModel, 'openai-oauth/gpt-5.4');
    assert.strictEqual(shadow.implementationCliModelArg, 'gpt-5.4');
    assert.strictEqual(shadow.implementationRunner, 'codex');
    assert.strictEqual(shadow.implementationModelSource, 'profile');
    assert.strictEqual(shadow.modelPolicyError, null);

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
    assert.strictEqual(autonomous.integrationMode, 'direct_push');
    assert.strictEqual(autonomous.implementationProvider, 'openai-oauth');
    assert.strictEqual(autonomous.implementationModel, 'openai-oauth/gpt-5.4');
    assert.strictEqual(autonomous.implementationCliModelArg, 'gpt-5.4');
    assert.strictEqual(autonomous.implementationRunner, 'codex');
    assert.strictEqual(autonomous.implementationModelSource, 'profile');
    assert.strictEqual(autonomous.modelPolicyError, null);
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
      CLAUDE_AUTO_DEV_MODEL: 'claude-code/opus',
      CLAUDE_AUTO_DEV_COMPAT_MODE: 'false',
    });

    assert.strictEqual(runtime.profile, 'shadow');
    assert.strictEqual(runtime.compatibilityMode, false);
    assert.strictEqual(runtime.enabled, false);
    assert.strictEqual(runtime.executeImplementation, false);
    assert.strictEqual(runtime.archiveOnSuccess, false);
    assert.strictEqual(runtime.runHardTests, false);
    assert.strictEqual(runtime.integrationMode, 'patch');
    assert.strictEqual(runtime.implementationModel, 'openai-oauth/gpt-5.4');
    assert.strictEqual(runtime.implementationCliModelArg, 'gpt-5.4');
    assert.strictEqual(runtime.implementationRunner, 'codex');
    assert.strictEqual(runtime.implementationModelSource, 'profile');
    assert.strictEqual(runtime.modelPolicyError, null);
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:enabled'));
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:executeImplementation'));
    assert.ok(runtime.ignoredLegacyOverrides.includes('env:CLAUDE_AUTO_DEV_INTEGRATION_MODE'));
    assert.ok(runtime.ignoredLegacyModelOverrides.includes('env:CLAUDE_AUTO_DEV_MODEL'));
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
      CLAUDE_AUTO_DEV_MODEL: 'claude-code/opus',
      CLAUDE_AUTO_DEV_COMPAT_MODE: 'true',
    });

    assert.strictEqual(runtime.compatibilityMode, true);
    assert.strictEqual(runtime.enabled, true);
    assert.strictEqual(runtime.executeImplementation, true);
    assert.strictEqual(runtime.archiveOnSuccess, true);
    assert.strictEqual(runtime.runHardTests, true);
    assert.strictEqual(runtime.integrationMode, 'cherry_pick');
    assert.strictEqual(runtime.implementationModel, 'claude-code/opus');
    assert.strictEqual(runtime.implementationCliModelArg, 'opus');
    assert.strictEqual(runtime.implementationModelSource, 'compat_env');
    assert.strictEqual(runtime.modelPolicyError, null);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: compatibility mode allows legacy env overrides');
}

async function test_hard_disabled_blocks_pipeline_even_with_autonomous_profile() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const runtime = pipeline.resolveAutoDevRuntimeConfig({}, {
      CLAUDE_AUTO_DEV_PROFILE: 'autonomous_l5',
      CLAUDE_AUTO_DEV_DISABLED: 'true',
    });

    assert.strictEqual(runtime.hardDisabled, true);
    assert.strictEqual(runtime.enabled, false);
    assert.strictEqual(runtime.shadow, true);
    assert.strictEqual(runtime.executeImplementation, false);
    assert.strictEqual(runtime.runHardTests, false);
    assert.strictEqual(runtime.integrationMode, 'none');

    const result = await pipeline.runAutoDevPipeline({
      once: true,
      runtimeConfig: runtime,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.processedCount, 0);
    assert.strictEqual(result.results[0].reason, 'hard_disabled');
    assert.strictEqual(result.lock.acquired, false);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: hard disabled blocks autonomous pipeline execution');
}

async function test_profile_compatibility_mode_blocks_unallowlisted_model() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const runtime = pipeline.resolveAutoDevRuntimeConfig({}, {
      CLAUDE_AUTO_DEV_PROFILE: 'autonomous_l5',
      CLAUDE_AUTO_DEV_COMPAT_MODE: 'true',
      CLAUDE_AUTO_DEV_MODEL: 'claude-code/haiku',
    });
    assert.strictEqual(runtime.implementationModel, 'openai-oauth/gpt-5.4');
    assert.match(String(runtime.modelPolicyError || ''), /지원하지 않는 auto_dev implementation model/i);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: compatibility mode blocks unallowlisted implementation model');
}

async function test_implementation_model_policy_failure_is_fail_closed() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_MODEL_POLICY_BLOCK.md', '# Model\npolicy block');
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const result = await pipeline.processAutoDevDocument(doc, {
      force: true,
      test: false,
      dryRun: false,
      executeImplementation: true,
      compatibilityMode: true,
      implementationModel: 'claude-code/haiku',
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /model_policy_blocked/i);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: unsupported implementation model fails closed before execution');
}

async function test_implementation_invocation_includes_model_arg() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_MODEL_ARG.md', '# Model\narg');
  const codexCalls = [];
  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = [], options = {}) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (String(command).endsWith('/codex') || command === 'codex') {
          codexCalls.push({ args, input: options.input });
          return 'ok';
        }
        if (command === 'claude') {
          throw new Error('claude CLI should not be used for OpenAI OAuth auto-dev');
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
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(codexCalls.length > 0, 'Codex CLI should be invoked for OpenAI OAuth auto-dev');
  const firstCall = codexCalls[0].args.map(String);
  assert.strictEqual(firstCall[0], 'exec');
  const modelFlagIndex = firstCall.indexOf('--model');
  assert.ok(modelFlagIndex >= 0, 'implementation CLI must include --model');
  assert.strictEqual(firstCall[modelFlagIndex + 1], 'gpt-5.4');
  assert.ok(firstCall.includes('--sandbox'), 'Codex runner must set sandbox explicitly');
  assert.ok(firstCall.includes('workspace-write'), 'Codex runner must default to workspace-write sandbox');
  assert.ok(String(codexCalls[0].input || '').includes('Source Document'), 'Codex runner must pass prompt through stdin');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: OpenAI OAuth implementation invokes Codex with explicit model');
}

async function test_claude_code_compat_invocation_includes_model_arg() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CLAUDE_MODEL_ARG.md', '# Model\narg');
  const claudeCalls = [];
  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = []) => {
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') {
          claudeCalls.push(args);
          return 'ok';
        }
        if (String(command).endsWith('/codex') || command === 'codex') {
          throw new Error('Codex CLI should not be used for Claude Code compatibility mode');
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
      compatibilityMode: true,
      implementationModel: 'claude-code/sonnet',
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(claudeCalls.length > 0, 'claude CLI should be invoked');
  const firstCall = claudeCalls[0].map(String);
  const modelFlagIndex = firstCall.indexOf('--model');
  assert.ok(modelFlagIndex >= 0, 'implementation CLI must include --model');
  assert.strictEqual(firstCall[modelFlagIndex + 1], 'sonnet');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: Claude Code compatibility path keeps explicit --model sonnet');
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
  assert.match(sidecarScript, /setInterval\(tick,\s*intervalMs\);/);
  assert.doesNotMatch(sidecarScript, /setInterval\(tick,\s*intervalMs\)\.unref\(\)/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: lock heartbeat sidecar validates parent liveness');
}

async function test_resolve_node_executable_prefers_stable_node_over_homebrew_cellar() {
  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auto-dev-node-bin-'));
  const stableNode = path.join(tmpBin, 'node');
  fs.writeFileSync(stableNode, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(stableNode, 0o755);

  delete require.cache[PIPELINE_PATH];
  const pipeline = require(PIPELINE_PATH);
  assert.strictEqual(
    pipeline._testOnly_resolveNodeExecutable({
      execPath: '/usr/local/Cellar/node/99.0.0/bin/node',
      pathEnv: tmpBin,
    }),
    stableNode
  );
  delete require.cache[PIPELINE_PATH];
  fs.rmSync(tmpBin, { recursive: true, force: true });
  console.log('✅ auto-dev: node executable resolver avoids Homebrew Cellar pinning');
}

async function test_dirty_base_is_ignored_when_worktree_isolated() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_DIRTY_SCOPE.md',
    withRequiredMetadata('# Dirty\nscope', { write_scope: ['bots/claude/**'] })
  );
  let rootStatusCalls = 0;
  let worktreeStatusCalls = 0;

  const { mocks } = makeMocks(tmpRoot, {
    child_process: {
      execFileSync: (command, args = []) => {
        if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
        if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'origin/main') return 'base-head\n';
        if (command === 'bash') return '/usr/local/bin/claude\n';
        if (command === 'claude') return 'ok';
        if (command === 'rg') throw new Error('no match');
        return '';
      },
      execSync: (command, opts = {}) => {
        if (String(command).includes('git status --short')) {
          if (String(opts.cwd || '').includes('claude-auto-dev-worktrees')) {
            worktreeStatusCalls += 1;
            return '';
          }
          rootStatusCalls += 1;
          return ' M bots/claude/src/reviewer.ts\n';
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
      archiveOnSuccess: false,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, undefined);
    assert.strictEqual(result.job.executionContext.mode, 'worktree');
    assert.strictEqual(result.job.executionContext.baseSha, 'base-head');
    assert.ok(worktreeStatusCalls > 0, 'worktree status는 실행 전후 확인해야 함');
    assert.strictEqual(rootStatusCalls, 0, 'ROOT dirty status는 auto-dev 차단 조건으로 읽지 않아야 함');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_PROFILE: 'autonomous_l5',
    CLAUDE_AUTO_DEV_COMPAT_MODE: 'false',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: dirty base is ignored under worktree isolation');
}

async function test_review_cycle_uses_execution_context() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_REVIEW_SCOPE.md', '# Review\nscope');
  let reviewerOptions = null;
  let guardianOptions = null;
  let builderOptions = null;

  const { mocks } = makeMocks(tmpRoot, {
    '../src/reviewer.ts': {
      runReview: async (opts) => {
        reviewerOptions = opts;
        return { summary: { pass: true }, message: 'review ok' };
      },
    },
    '../src/guardian.ts': {
      runFullSecurityScan: async (opts) => {
        guardianOptions = opts;
        return { pass: true, message: 'guardian ok', critical: [], high: [], layers: {} };
      },
    },
    '../src/builder': {
      runBuildCheck: async (opts) => {
        builderOptions = opts;
        return { pass: true, message: 'build ok', results: [] };
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

  assert.ok(reviewerOptions && guardianOptions && builderOptions, 'reviewer/guardian/builder 호출 옵션이 기록되어야 함');
  assert.strictEqual(reviewerOptions.suppressAlarm, true, 'auto-dev 내부 리뷰는 재귀 Hub 알람을 만들면 안 됨');
  assert.ok(String(reviewerOptions.rootDir || '').includes('claude-auto-dev-worktrees'));
  assert.ok(Array.isArray(reviewerOptions.files), 'reviewer files 전달 필요');
  assert.ok(Array.isArray(guardianOptions.files), 'guardian files 전달 필요');
  assert.strictEqual(builderOptions.rootDir, reviewerOptions.rootDir, 'builder도 같은 worktree root를 사용해야 함');
  assert.deepStrictEqual(builderOptions.files, reviewerOptions.files, 'builder도 같은 변경 파일 집합을 검사해야 함');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: review/guardian use worktree execution context');
}

async function test_hard_tests_follow_target_package_contract() {
  const tmpRoot = makeTempRoot();
  const claudePackage = path.join(tmpRoot, 'bots', 'claude');
  const reservationPackage = path.join(tmpRoot, 'bots', 'reservation');
  fs.mkdirSync(claudePackage, { recursive: true });
  fs.mkdirSync(reservationPackage, { recursive: true });
  fs.writeFileSync(path.join(claudePackage, 'package.json'), JSON.stringify({
    scripts: { typecheck: 'tsc', 'test:unit': 'node unit.js' },
  }), 'utf8');
  fs.writeFileSync(path.join(reservationPackage, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');

  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const claude = pipeline._testOnly_resolveHardTestCommands({
      metadata: { target_team: 'claude', write_scope: ['bots/claude/**'] },
    }, tmpRoot, {});
    assert.deepStrictEqual(claude.commands, [
      "npm --prefix 'bots/claude' run typecheck",
      "npm --prefix 'bots/claude' run test:unit",
    ]);
    assert.strictEqual(claude.source, 'target_package_scripts');

    const reservation = pipeline._testOnly_resolveHardTestCommands({
      metadata: { target_team: 'reservation', write_scope: ['bots/reservation/**'] },
    }, tmpRoot, {});
    assert.deepStrictEqual(reservation.commands, []);
    assert.strictEqual(reservation.source, 'scoped_test_contract');

    const configured = pipeline._testOnly_resolveHardTestCommands({
      metadata: { target_team: 'reservation' },
    }, tmpRoot, { CLAUDE_AUTO_DEV_HARD_TEST_COMMANDS: 'npm --prefix bots/claude run typecheck' });
    assert.deepStrictEqual(configured.commands, ['npm --prefix bots/claude run typecheck']);
    assert.strictEqual(configured.source, 'configured');
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: hard tests follow target package contract');
}

async function test_validation_failure_context_is_actionable_and_redacted() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);
  await withMocks(mocks, async pipeline => {
    const message = pipeline._testOnly_formatTestCycleMessage({
      build: { pass: true, results: [] },
      commands: [{
        command: "npm --prefix 'bots/claude' run test:unit",
        pass: false,
        output: 'AssertionError: member 010-1234-5678 user@example.com expected 1',
      }],
      scopedCommands: [{ command: "npm --prefix 'bots/claude' run test:auto-dev", pass: true, output: 'ok' }],
      hardTestSource: 'target_package_scripts',
      targetTeam: 'claude',
    });
    assert.match(message, /npm --prefix 'bots\/claude' run test:unit/);
    assert.match(message, /AssertionError/);
    assert.match(message, /\[redacted-phone\]/);
    assert.match(message, /\[redacted-email\]/);
    assert.doesNotMatch(message, /010-1234-5678|user@example\.com/);
  }, testEnv(tmpRoot));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: validation failure context is actionable and redacted');
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

async function test_test_scope_allows_hub_scoped_commands() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_TEST_SCOPE_HUB_ALLOWED.md',
    withRequiredMetadata('# Hub Scope\nallow', {
      test_scope: [
        'npm --prefix bots/hub run test:unit',
        'npm --prefix bots/hub run transition:completion-gate',
      ],
    }),
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const analysis = pipeline.analyzeAutoDevDocument(doc);
    const scoped = pipeline._testOnly_resolveScopedTestCommands(analysis, tmpRoot);
    assert.deepStrictEqual(scoped.rejected, []);
    assert.deepStrictEqual(scoped.commands, [
      "npm --prefix 'bots/hub' run test:unit",
      "npm --prefix 'bots/hub' run transition:completion-gate",
    ]);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: hub scoped test_scope commands are allowed');
}

async function test_test_scope_normalizes_silent_hub_commands() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(
    tmpRoot,
    'CODEX_TEST_SCOPE_HUB_SILENT_ALLOWED.md',
    withRequiredMetadata('# Hub Scope\nallow silent', {
      test_scope: [
        'npm --prefix bots/hub run -s test:unit',
        'npm --prefix bots/hub run --silent transition:completion-gate',
      ],
    }),
  );
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const analysis = pipeline.analyzeAutoDevDocument(doc);
    const scoped = pipeline._testOnly_resolveScopedTestCommands(analysis, tmpRoot);
    assert.deepStrictEqual(scoped.rejected, []);
    assert.deepStrictEqual(scoped.commands, [
      "npm --prefix 'bots/hub' run test:unit",
      "npm --prefix 'bots/hub' run transition:completion-gate",
    ]);
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: silent hub scoped test_scope commands are normalized');
}

async function test_test_scope_npm_boundary_matrix() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const allowed = [
      'npm --prefix bots/blog run -s test:unit',
      'npm --prefix bots/reservation run --silent typecheck',
      'npm run -s test:unit --prefix bots/claude',
    ];
    const valid = pipeline._testOnly_resolveScopedTestCommands({
      metadata: { test_scope: allowed },
    }, tmpRoot);
    assert.deepStrictEqual(valid.rejected, []);
    assert.deepStrictEqual(valid.commands, [
      "npm --prefix 'bots/blog' run test:unit",
      "npm --prefix 'bots/reservation' run typecheck",
      "npm --prefix 'bots/claude' run test:unit",
    ]);

    const blocked = [
      'npm --prefix bots/blog run test:unit; touch /tmp/pwned',
      'npm --prefix bots/blog run test:unit && whoami',
      'npm --prefix bots/blog run test:unit | cat',
      'npm --prefix bots/blog run test:unit $(id)',
      'npm --prefix bots/blog run test:unit `id`',
      'npm --prefix bots/claude/../hub run test:unit',
    ];
    for (const entry of blocked) {
      const invalid = pipeline._testOnly_resolveScopedTestCommands({
        metadata: { test_scope: [entry] },
      }, tmpRoot);
      assert.strictEqual(invalid.commands.length, 0, entry);
      assert.strictEqual(invalid.rejected.length, 1, entry);
      if (/[;&|$`]/.test(entry)) {
        assert.strictEqual(invalid.rejected[0].reason, 'shell_meta_character', entry);
      } else {
        assert.match(invalid.rejected[0].reason, /prefix_not_allowlisted|prefix_invalid/, entry);
      }
    }
  }, testEnv(tmpRoot));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: test_scope accepts bots/<team> npm commands and blocks shell boundaries');
}

async function test_test_scope_configured_prefix_allowlist_is_authoritative() {
  const tmpRoot = makeTempRoot();
  const { mocks } = makeMocks(tmpRoot);

  await withMocks(mocks, async pipeline => {
    const scoped = pipeline._testOnly_resolveScopedTestCommands({
      metadata: { test_scope: ['npm --prefix bots/reservation run typecheck'] },
    }, tmpRoot);
    assert.deepStrictEqual(scoped.commands, []);
    assert.deepStrictEqual(scoped.rejected, [{
      entry: 'npm --prefix bots/reservation run typecheck',
      reason: 'prefix_not_allowlisted:bots/reservation',
    }]);
    assert.deepStrictEqual(scoped.prefixAllowlist, ['bots/claude', 'packages/core']);

    const configuredNonBotPrefix = pipeline._testOnly_resolveScopedTestCommands({
      metadata: { test_scope: ['npm --prefix packages/core run typecheck'] },
    }, tmpRoot);
    assert.deepStrictEqual(configuredNonBotPrefix.rejected, []);
    assert.deepStrictEqual(configuredNonBotPrefix.commands, ["npm --prefix 'packages/core' run typecheck"]);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_TEST_SCOPE_PREFIX_ALLOWLIST: 'bots/claude,packages/core',
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: configured test_scope prefix allowlist is authoritative');
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
    assert.strictEqual(manifest.implementationModelMeta?.provider, 'openai-oauth');
    assert.strictEqual(manifest.implementationModelMeta?.model, 'openai-oauth/gpt-5.4');
    assert.strictEqual(manifest.implementationModelMeta?.cliModelArg, 'gpt-5.4');
    assert.strictEqual(manifest.implementationModelMeta?.runner, 'codex');
    assert.strictEqual(manifest.implementationModelMeta?.source, 'profile');
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

async function test_archive_manifest_failure_does_not_push_direct_commit() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_DIRECT_PUSH_ARCHIVE_FAIL.md', '# Direct\narchive fail');
  const gitCalls = [];
  let worktreeStatusCalls = 0;
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
          if (joined === 'rev-parse origin/main') return 'base-head\n';
          if (joined === 'rev-parse HEAD') return inWorktree ? 'worktree-commit\n' : 'root-head\n';
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
      integrationMode: 'direct_push',
      archiveOnSuccess: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error || ''), /archive failed|manifest_write_failed/i);
    assert.strictEqual(result.job.integrationRollback?.reason, 'direct_push_not_pushed');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(!gitCalls.some(call => call.args.join(' ') === 'push origin HEAD:main'), 'archive failure must not push a direct integration commit');
  assert.ok(fs.existsSync(doc), 'archive failure should restore source document');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: archive manifest failure does not push direct commit');
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

async function test_direct_push_integration_commits_and_pushes_from_worktree() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_DIRECT_PUSH.md', '# Direct\npush');
  const gitCalls = [];
  let worktreeStatusCalls = 0;
  let rootStatusCalls = 0;

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
          if (joined === 'rev-parse origin/main') return 'base-head\n';
          if (joined === 'rev-parse HEAD') return inWorktree ? 'worktree-commit\n' : 'root-head\n';
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
          rootStatusCalls += 1;
          return ' M bots/claude/src/reviewer.ts\n';
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
      integrationMode: 'direct_push',
      archiveOnSuccess: true,
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.integration.mode, 'direct_pushed');
    assert.strictEqual(result.integration.targetBranch, 'main');
    assert.strictEqual(result.integration.pushed, true);
    assert.strictEqual(result.integration.targetPush?.ref, 'origin/main');
    assert.strictEqual(result.job.targetPush.reason, 'pushed_from_worktree');
    assert.strictEqual(result.job.integrationAuditUpdate?.archiveManifest?.updated, true);
    assert.strictEqual(result.job.integrationAuditUpdate?.completionDocument?.updated, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, result.job.archiveManifestPath), 'utf8'));
    assert.strictEqual(manifest.integration.mode, 'direct_pushed');
    assert.strictEqual(manifest.integration.targetPush.reason, 'pushed_from_worktree');
    const archivedContent = fs.readFileSync(path.join(tmpRoot, result.job.completionDocumentPath), 'utf8');
    assert.match(archivedContent, /integration_mode: `direct_pushed`/);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(gitCalls.some(call => call.args.includes('commit')), 'worktree changes must be committed before direct push');
  assert.ok(
    gitCalls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add' && call.args[2] === '--detach' && call.args[4] === 'base-head'),
    'detached implementation worktree must be based on origin/main'
  );
  assert.ok(gitCalls.some(call => call.args.join(' ') === 'push origin HEAD:main'), 'worktree commit must be pushed directly to origin/main');
  assert.ok(!gitCalls.some(call => call.args.join(' ') === 'switch main'), 'direct push must not switch the ROOT worktree branch');
  assert.ok(!gitCalls.some(call => call.args[0] === 'cherry-pick'), 'direct push must not cherry-pick through ROOT');
  assert.strictEqual(rootStatusCalls, 0, 'direct push must not inspect ROOT dirty status');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: direct push integration commits and pushes from worktree');
}

async function test_cherry_pick_integration_commits_and_applies_patch() {
  const tmpRoot = makeTempRoot();
  const doc = makeDoc(tmpRoot, 'CODEX_CHERRY_PICK.md', '# Cherry\npick');
  const gitCalls = [];
  let worktreeStatusCalls = 0;
  let rootBranch = 'codex/feature-work';

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
          if (joined === 'rev-parse origin/main') return 'base-head\n';
          if (joined === 'rev-parse HEAD') return inWorktree ? 'worktree-commit\n' : 'base-head\n';
          if (joined === 'rev-parse --abbrev-ref HEAD') return `${rootBranch}\n`;
          if (joined === 'switch main') {
            rootBranch = 'main';
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
      maxRevisionPasses: 0,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.integration.mode, 'cherry_picked');
    assert.strictEqual(result.integration.targetBranch, 'main');
    assert.strictEqual(result.integration.pushed, true);
    assert.strictEqual(result.integration.targetPush?.ref, 'origin/main');
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION: 'true',
  }));

  assert.ok(gitCalls.some(call => call.args.includes('commit')), 'worktree changes must be committed before cherry-pick');
  assert.ok(gitCalls.some(call => call.args.join(' ') === 'switch main'), 'legacy cherry-pick integration must switch the root worktree to main');
  assert.ok(
    gitCalls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add' && call.args[2] === '--detach' && call.args[4] === 'base-head'),
    'detached implementation worktree must be based on origin/main'
  );
  assert.ok(gitCalls.some(call => call.args[0] === 'cherry-pick'), 'worktree commit must be cherry-picked into main');
  assert.ok(gitCalls.some(call => call.args.join(' ') === 'push origin main'), 'successful cherry-pick must be pushed to origin/main');

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
  makeDoc(tmpRoot, 'ALARM_INCIDENT_STATUS.md', '# Status\nsnapshot');
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
        relPath: 'docs/auto_dev/ALARM_INCIDENT_STATUS.md',
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
    assert.strictEqual(snapshot.targetBranch, 'main');
    assert.strictEqual(snapshot.targetRemote, 'origin');
    assert.strictEqual(snapshot.baseRef, 'origin/main');
    assert.strictEqual(snapshot.rootIsolation, true);
  }, testEnv(tmpRoot, {
    CLAUDE_AUTO_DEV_STATE_FILE: statePath,
    CLAUDE_AUTO_DEV_WORKTREE_DIR: worktreeDir,
    CLAUDE_AUTO_DEV_ARTIFACT_DIR: artifactDir,
  }));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('✅ auto-dev: status snapshot includes profile/worktree/patch counts');
}

async function test_selector_agents_persist_actual_fallback_model_metadata() {
  const aiAnalystSrc = fs.readFileSync(path.resolve(__dirname, '../lib/ai-analyst.ts'), 'utf8');
  const leadSrc = fs.readFileSync(path.resolve(__dirname, '../lib/claude-lead-brain.ts'), 'utf8');
  const archerSrc = fs.readFileSync(path.resolve(__dirname, '../lib/archer/analyzer.ts'), 'utf8');

  assert.ok(aiAnalystSrc.includes('await callHubLlm({'));
  assert.ok(aiAnalystSrc.includes("const selectorKey = 'claude.dexter.ai_analyst'"));
  assert.ok(aiAnalystSrc.includes('fallbackUsed'));
  assert.ok(aiAnalystSrc.includes('degradedFallback'));
  assert.ok(aiAnalystSrc.includes('source: fallbackUsed ? \'fallback\' : \'selector\''));

  assert.ok(leadSrc.includes('await callHubLlm({'));
  assert.ok(leadSrc.includes("selectorKey:  LLM_SELECTOR_KEY"));
  assert.ok(leadSrc.includes('llmResult._llm_meta = llmMeta'));
  assert.ok(leadSrc.includes('degradedFallbackGuard'));
  assert.ok(leadSrc.includes('run_doctor'));

  assert.ok(archerSrc.includes('await callHubLlm({'));
  assert.ok(archerSrc.includes('selectorKey:  ARCHER_SELECTOR_KEY'));
  assert.ok(archerSrc.includes('parsed._llm_meta = llmMeta'));

  console.log('✅ auto-dev: selector agents persist actual fallback model metadata');
}

async function main() {
  console.log('=== Auto Dev Pipeline 테스트 시작 ===\n');
  const tests = [
    test_manifest_lock_release_preserves_replacement_owner,
    test_manifest_async_lock_wait_yields_event_loop,
    test_manifest_stale_reclaim_serializes_contenders,
    test_manifest_stale_empty_lock_is_recoverable,
    test_manifest_orphan_reclaim_guard_is_recoverable,
    test_stages_define_required_lifecycle,
    test_js_bridge_loads_pipeline_status_snapshot,
    test_status_snapshot_reconciles_stale_missing_running_jobs,
    test_listAutoDevDocuments_uses_auto_dev_only,
    test_listAutoDevDocuments_respects_manifest_states,
    test_regenerated_archived_document_reenters_inbox,
    test_legacy_archived_document_without_hash_uses_archive_content,
    test_empty_auto_dev_inbox_marks_agent_done,
    test_completed_history_prevents_archived_missing_requeue,
    test_completed_manifest_record_blocks_failed_overwrite,
    test_completed_manifest_during_execution_suppresses_failure_alarm,
    test_completed_manifest_suppresses_failure_at_notification_boundary,
    test_alarm_repair_result_uses_callback_contract,
    test_alarm_repair_progress_carries_attempt_contract,
    test_completed_alarm_callback_failure_is_retried_without_reimplementation,
    test_archived_missing_pending_callback_is_retried,
    test_callback_retry_does_not_archive_regenerated_generation,
    test_permanent_callback_failure_does_not_starve_following_entry,
    test_callback_retry_exception_releases_global_lock,
    test_regenerated_incident_with_same_path_keeps_failure_alarm,
    test_archived_missing_without_completed_history_requeues,
    test_auto_dev_watch_passes_state_file_to_manifest_sync,
    test_missing_auto_dev_document_is_skipped,
    test_missing_auto_dev_document_after_listing_is_skipped,
    test_success_only_blog_engagement_alarm_is_skipped,
    test_reservation_booking_alert_is_skipped,
    test_reservation_cancel_blocked_alert_is_skipped,
    test_ops_emergency_telegram_snapshot_is_skipped,
    test_investment_position_watch_alert_is_skipped,
    test_claude_health_snapshot_is_skipped,
    test_blog_instagram_snapshot_is_skipped,
    test_auto_dev_self_alarm_is_skipped,
    test_blog_health_recovery_snapshot_is_skipped,
    test_analyzeAutoDevDocument_extracts_code_refs,
    test_processAutoDevDocument_runs_full_dry_pipeline,
    test_auto_dev_failed_outcome_masks_secrets,
    test_failure_circuit_breaker_dead_letters_once_and_allows_new_hash,
    test_dead_letter_move_failure_stays_terminal,
    test_record_outcome_accepts_refactor_meta_tags,
    test_record_outcome_normalizes_error_summary_and_keeps_raw_meta,
    test_stale_running_job_retries_with_recovery_count,
    test_stale_running_job_blocks_after_recovery_exhaustion,
    test_invalid_stale_recovery_env_falls_back_to_default_limit,
    test_completed_document_is_updated_after_actual_implementation,
    test_completed_job_is_skipped_without_force,
    test_content_hash_job_id_prevents_touch_reprocessing,
    test_review_failure_triggers_single_revise_loop,
    test_test_failure_triggers_single_revise_loop,
    test_state_file_override_is_used,
    test_missing_metadata_is_blocked,
    test_non_development_task_is_blocked,
    test_implementation_completed_marker_is_skipped,
    test_implementation_completed_alarm_emits_resolved_callback,
    test_non_claude_target_is_routed,
    test_global_lock_blocks_parallel_pipeline,
    test_job_lock_blocks_duplicate_document_execution,
    test_completed_state_clears_active_error,
    test_launchd_plist_defaults_are_safe,
    test_codex_cli_path_precedence_and_fallback_chain,
    test_codex_cli_unavailable_is_non_retryable_and_trips_breaker,
    test_profile_resolver_maps_runtime_profiles,
    test_profile_authoritative_blocks_legacy_overrides,
    test_profile_compatibility_mode_allows_legacy_overrides,
    test_hard_disabled_blocks_pipeline_even_with_autonomous_profile,
    test_profile_compatibility_mode_blocks_unallowlisted_model,
    test_implementation_model_policy_failure_is_fail_closed,
    test_implementation_invocation_includes_model_arg,
    test_claude_code_compat_invocation_includes_model_arg,
    test_bash_is_fail_closed_without_allowlist,
    test_lock_heartbeat_sidecar_enforces_parent_liveness,
    test_resolve_node_executable_prefers_stable_node_over_homebrew_cellar,
    test_dirty_base_is_ignored_when_worktree_isolated,
    test_review_cycle_uses_execution_context,
    test_hard_tests_follow_target_package_contract,
    test_validation_failure_context_is_actionable_and_redacted,
    test_test_scope_is_executed_in_non_test_mode,
    test_test_scope_rejects_unsafe_shell_command,
    test_test_scope_allows_hub_scoped_commands,
    test_test_scope_normalizes_silent_hub_commands,
    test_test_scope_npm_boundary_matrix,
    test_test_scope_configured_prefix_allowlist_is_authoritative,
    test_archive_manifest_is_created,
    test_archive_manifest_failure_is_fail_closed,
    test_archive_manifest_failure_does_not_push_direct_commit,
    test_archive_manifest_failure_rolls_back_cherry_pick,
    test_worktree_cleanup_runs_after_success,
    test_direct_push_integration_commits_and_pushes_from_worktree,
    test_cherry_pick_integration_commits_and_applies_patch,
    test_cherry_pick_failure_aborts_and_fails_closed,
    test_status_snapshot_includes_profile_worktree_patch_counts,
    test_selector_agents_persist_actual_fallback_model_metadata,
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
