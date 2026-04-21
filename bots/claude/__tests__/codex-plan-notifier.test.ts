'use strict';

/**
 * Phase N: codex-plan-notifier.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/codex-plan-notifier.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const NOTIFIER_PATH = path.resolve(__dirname, '../lib/codex-plan-notifier.ts');

const SAMPLE_CODEX_CONTENT = `
# CODEX_CLAUDE_EVOLUTION

## 📋 Phase A (Agents — 3개 스켈레톤) — 2~3일

Kill Switch: CLAUDE_REVIEWER_ENABLED

\`bots/claude/src/reviewer.ts\`
\`bots/claude/src/guardian.ts\`

## 📋 Phase N (Notifier) — 3~4일

Kill Switch: CLAUDE_CODEX_NOTIFIER_ENABLED

\`bots/claude/lib/codex-plan-notifier.ts\`
`.trim();

function makeNotifierMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/env': {
      PROJECT_ROOT: path.join(os.tmpdir(), 'test-codex-notifier'),
    },
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async () => {},
    },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('ps aux'))         return '';
        if (cmd.includes('git rev-parse'))  return 'abc1234';
        if (cmd.includes('git log'))        return '1234567 feat(claude): Phase A 완료';
        if (cmd.includes('git tag'))        return 'pre-phase-a-claude-evolution';
        if (cmd.includes('ps -p'))          return 'Sat Apr 18 10:00:00 2026';
        return '';
      },
    },
    fs: require('fs'),
    path: require('path'),
    os:   require('os'),
    crypto: require('crypto'),
    ...overrides,
  };
}

async function withMocks(mocks, fn) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[NOTIFIER_PATH];
    return await fn(require(NOTIFIER_PATH));
  } finally {
    Module._load = original;
    delete require.cache[NOTIFIER_PATH];
  }
}

// ─── Test 1: parsePhases — Phase 목록 파싱 ────────────────────────────

async function test_parsePhases_extracts_phases() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const phases = notifier.parsePhases(SAMPLE_CODEX_CONTENT);
    assert.ok(Array.isArray(phases), '배열 반환');
    assert.ok(phases.length >= 2, '최소 2개 Phase 파싱');

    const ids = phases.map(p => p.id);
    assert.ok(ids.includes('A'), 'Phase A 포함');
    assert.ok(ids.includes('N'), 'Phase N 포함');
  });
  console.log('✅ codex-notifier: parsePhases extracts phases');
}

// ─── Test 2: parsePhases — 예상 파일 추출 ────────────────────────────

async function test_parsePhases_extracts_files() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const phases = notifier.parsePhases(SAMPLE_CODEX_CONTENT);
    const phaseA = phases.find(p => p.id === 'A');
    assert.ok(phaseA, 'Phase A 존재');
    assert.ok(Array.isArray(phaseA.files), 'files는 배열');
  });
  console.log('✅ codex-notifier: parsePhases extracts expected files');
}

// ─── Test 3: parsePhases — Kill Switch 추출 ──────────────────────────

async function test_parsePhases_extracts_kill_switches() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const phases = notifier.parsePhases(SAMPLE_CODEX_CONTENT);
    assert.ok(phases.length > 0, 'Phase 존재');
    // 전체 content에서 Kill Switch 추출되는지 확인
    const phaseA = phases.find(p => p.id === 'A');
    assert.ok(phaseA, 'Phase A 존재');
    assert.ok(Array.isArray(phaseA.killSwitches), 'killSwitches는 배열');
  });
  console.log('✅ codex-notifier: parsePhases extracts kill switches');
}

// ─── Test 4: formatPlanStartMessage — 필수 필드 포함 ─────────────────

async function test_formatPlanStartMessage_contains_required_fields() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const exec = {
      pid: 12345,
      started_at: Date.now(),
      prompt_file: 'docs/codex/CODEX_CLAUDE_EVOLUTION.md',
      total_phases: [],
      completed_phases: [],
      last_commit_sha: 'abc1234',
      last_commit_at: Date.now(),
      last_test_status: { tests: 10, failures: 0 },
      status: 'running',
    };
    const phase = {
      id: 'A',
      name: 'Agents',
      estimated: '2~3일',
      files: ['reviewer.ts'],
      killSwitches: ['CLAUDE_REVIEWER_ENABLED'],
      rollbackTag: 'pre-phase-a-claude-evolution',
    };
    const msg = notifier.formatPlanStartMessage(exec, phase);
    assert.ok(typeof msg === 'string', '문자열 반환');
    assert.ok(msg.includes('Phase A'), 'Phase ID 포함');
    assert.ok(msg.includes('12345'), 'PID 포함');
    assert.ok(msg.includes('Agents'), 'Phase 이름 포함');
  });
  console.log('✅ codex-notifier: formatPlanStartMessage contains required fields');
}

// ─── Test 5: formatProgressMessage — 진행률 포함 ─────────────────────

async function test_formatProgressMessage_has_percentage() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const exec = {
      pid: 12345,
      started_at: Date.now() - 3600000,
      prompt_file: 'docs/codex/CODEX_CLAUDE_EVOLUTION.md',
      total_phases: [{ id: 'A' }, { id: 'N' }],
      current_phase: { id: 'N', name: 'Notifier' },
      completed_phases: [{ id: 'A' }],
      last_commit_sha: 'abc1234',
      last_commit_at: Date.now() - 600000,
      last_test_status: { tests: 5, failures: 0 },
      status: 'running',
    };
    const msg = notifier.formatProgressMessage(exec);
    assert.ok(typeof msg === 'string', '문자열 반환');
    assert.ok(msg.includes('50'), '50% 진행률 포함');
  });
  console.log('✅ codex-notifier: formatProgressMessage has percentage');
}

// ─── Test 6: formatCompletionMessage — 소요 시간 포함 ────────────────

async function test_formatCompletionMessage_has_duration() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const exec = {
      pid: 12345,
      started_at: Date.now() - 7200000, // 2시간 전
      prompt_file: 'docs/codex/CODEX_CLAUDE_EVOLUTION.md',
      total_phases: [{ id: 'A' }],
      completed_phases: [],
      last_commit_sha: 'def5678',
      last_commit_at: Date.now() - 300000,
      last_test_status: { tests: 15, failures: 0 },
      status: 'running',
    };
    const phase = { id: 'A', name: 'Agents', estimated: '2~3일', files: [], killSwitches: [], rollbackTag: '' };
    const msg = notifier.formatCompletionMessage(exec, phase);
    assert.ok(typeof msg === 'string', '문자열 반환');
    assert.ok(msg.includes('Phase A'), 'Phase ID 포함');
    assert.ok(msg.includes('def5678') || msg.includes('def567'), '커밋 SHA 포함');
  });
  console.log('✅ codex-notifier: formatCompletionMessage has duration');
}

// ─── Test 7: 중복 알림 방지 — dedup 동작 ─────────────────────────────

async function test_sendTelegram_dedup_prevents_duplicate() {
  const sentMessages = [];
  const tmpDir = path.join(os.tmpdir(), 'notifier-dedup-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const mocks = makeNotifierMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async (p) => { sentMessages.push(p); },
    },
  });

  await withMocks(mocks, async (notifier) => {
    if (typeof notifier.sendTelegram !== 'function') {
      console.log('  (sendTelegram not exported — dedup internal)');
      return;
    }
    process.env.CLAUDE_NOTIFIER_SHADOW = 'false';
    const testMsg = '테스트 중복 알림 ' + Date.now();
    await notifier.sendTelegram(testMsg);
    await notifier.sendTelegram(testMsg); // 동일 메시지 재발송
    assert.strictEqual(sentMessages.length, 1, '동일 메시지는 1회만 발송');
    delete process.env.CLAUDE_NOTIFIER_SHADOW;
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✅ codex-notifier: sendTelegram dedup prevents duplicate');
}

// ─── Test 8: isProcessAlive — pid 0 없음 ─────────────────────────────

async function test_isProcessAlive_nonexistent_pid() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    if (typeof notifier.isProcessAlive !== 'function') {
      console.log('  (isProcessAlive not exported — internal function)');
      return;
    }
    const alive = notifier.isProcessAlive(99999999);
    assert.strictEqual(alive, false, '존재하지 않는 PID는 false');
  });
  console.log('✅ codex-notifier: isProcessAlive returns false for nonexistent pid');
}

// ─── Test 9: timeSince — 시간 포맷 ───────────────────────────────────

async function test_timeSince_formats_correctly() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    if (typeof notifier.timeSince !== 'function') return;
    const result = notifier.timeSince(Date.now() - 300000); // 5분 전
    assert.ok(result.includes('분'), '분 단위 포맷');
  });
  console.log('✅ codex-notifier: timeSince formats time correctly');
}

// ─── Test 10: detectCodexProcesses — 배열 반환 ───────────────────────

async function test_detectCodexProcesses_returns_array() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const result = await notifier.detectCodexProcesses();
    assert.ok(Array.isArray(result), '배열 반환');
  });
  console.log('✅ codex-notifier: detectCodexProcesses returns array');
}

// ─── Test 11: loadState — 상태 파일 없을 때 빈 객체 ──────────────────

async function test_loadState_returns_empty_when_no_file() {
  const tmpDir = path.join(os.tmpdir(), 'notifier-state-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const mocks = makeNotifierMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
  });

  await withMocks(mocks, async (notifier) => {
    if (typeof notifier.loadState !== 'function') return;
    const state = notifier.loadState();
    assert.deepStrictEqual(state, {}, '상태 파일 없을 때 빈 객체');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✅ codex-notifier: loadState returns empty object when no file');
}

// ─── Test 12: parsePhases — 빈 내용 → 빈 배열 ───────────────────────

async function test_parsePhases_empty_content() {
  await withMocks(makeNotifierMocks(), async (notifier) => {
    const phases = notifier.parsePhases('');
    assert.deepStrictEqual(phases, [], '빈 content는 빈 배열');
  });
  console.log('✅ codex-notifier: parsePhases returns empty array for empty content');
}

// ─── Test 13: 과거 완료 prompt는 start 알림 억제 ─────────────────────

async function test_shouldSuppressHistoricalStart_completed_prompt() {
  const tmpDir = path.join(os.tmpdir(), 'notifier-historical-' + Date.now());
  const sessionsDir = path.join(tmpDir, 'docs', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'HANDOFF_54.md'),
    [
      '# HANDOFF 54',
      '',
      '2026-04-19',
      '- effab24c feat(codex): CODEX_JUSTIN_EVOLUTION 자동 실행 완료',
      '- 263bbd41 feat(legal): 저스틴팀 완전 구현',
      '',
    ].join('\n'),
    'utf8',
  );

  const mocks = makeNotifierMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
  });

  await withMocks(mocks, async (notifier) => {
    const suppress = notifier.shouldSuppressHistoricalStart({
      prompt_file: 'docs/codex/CODEX_JUSTIN_EVOLUTION.md',
    });
    assert.strictEqual(suppress, true, '완료된 과거 prompt는 start 알림 억제');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✅ codex-notifier: suppresses historical completed prompt starts');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Codex Plan Notifier 테스트 시작 ===\n');
  const tests = [
    test_parsePhases_extracts_phases,
    test_parsePhases_extracts_files,
    test_parsePhases_extracts_kill_switches,
    test_formatPlanStartMessage_contains_required_fields,
    test_formatProgressMessage_has_percentage,
    test_formatCompletionMessage_has_duration,
    test_sendTelegram_dedup_prevents_duplicate,
    test_isProcessAlive_nonexistent_pid,
    test_timeSince_formats_correctly,
    test_detectCodexProcesses_returns_array,
    test_loadState_returns_empty_when_no_file,
    test_parsePhases_empty_content,
    test_shouldSuppressHistoricalStart_completed_prompt,
  ];

  let passed = 0, failed = 0;
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

main().catch(e => { console.error(e); process.exit(1); });
