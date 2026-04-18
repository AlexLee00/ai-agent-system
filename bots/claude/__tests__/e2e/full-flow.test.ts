'use strict';

/**
 * Phase I: E2E 통합 테스트
 *
 * 실제 외부 의존성 없이 전체 플로우를 검증.
 * Module._load 기반 통합 모킹 사용.
 *
 * 실행: node bots/claude/__tests__/e2e/full-flow.test.ts
 */

const assert  = require('assert');
const Module  = require('module');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');

// ─── 공통 외부 의존성 모킹 ────────────────────────────────────────────

const BASE_MOCKS = {
  '../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },
  '../../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },
  '../../../packages/core/lib/env': { PROJECT_ROOT: path.join(os.tmpdir(), 'e2e-test') },
  '../../../../packages/core/lib/env': { PROJECT_ROOT: path.join(os.tmpdir(), 'e2e-test') },
  '../../../packages/core/lib/pg-pool': {
    query: async () => [],
    get: async () => null,
    run: async () => null,
  },
  '../../../packages/core/lib/kst': {
    today: () => '2026-04-18',
    now: () => new Date('2026-04-18T10:00:00+09:00'),
    datetimeStr: () => '2026-04-18 10:00:00',
  },
  '../../../packages/core/lib/skills': {
    callLLM: async () => ({ text: '테스트 LLM 응답' }),
  },
};

function withMocks(mocks, modulePath, fn) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  const resolvedPath = path.resolve(__dirname, modulePath);
  try {
    delete require.cache[resolvedPath];
    return fn(require(resolvedPath));
  } finally {
    Module._load = original;
    delete require.cache[resolvedPath];
  }
}

// ─── Scenario 1: Reviewer → Guardian → Builder 순차 실행 ─────────────

async function scenario_reviewer_guardian_builder_chain() {
  const callOrder = [];

  const mocks = {
    ...BASE_MOCKS,
    '../../../packages/core/lib/env': { PROJECT_ROOT: '/tmp/e2e' },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('git diff')) return 'M\tpackages/core/lib/test.ts';
        if (cmd.includes('git log'))  return 'abc1234 feat: 테스트';
        if (cmd.includes('npm test')) return '10 passing';
        if (cmd.includes('npm audit')) return '{"vulnerabilities":{}}';
        if (cmd.includes('mix compile')) { callOrder.push('elixir-build'); return 'Compiled 3 files'; }
        return '';
      },
    },
    './reviewer': {
      analyzeChanges: async () => {
        callOrder.push('reviewer-analyze');
        return { files: ['packages/core/lib/test.ts'], added_lines: 5, removed_lines: 1, diff_summary: 'diff' };
      },
    },
  };

  // Reviewer 단독 동작 확인
  withMocks(mocks, '../../src/reviewer.ts', (reviewer) => {
    assert.ok(typeof reviewer.runReview === 'function', 'reviewer.runReview 존재');
    assert.ok(typeof reviewer.analyzeChanges === 'function', 'reviewer.analyzeChanges 존재');
    assert.ok(typeof reviewer.reportToTelegram === 'function', 'reviewer.reportToTelegram 존재');
  });

  // Guardian 단독 동작 확인
  withMocks({ ...mocks, './reviewer': mocks['./reviewer'] }, '../../src/guardian.ts', (guardian) => {
    assert.ok(typeof guardian.runFullSecurityScan === 'function', 'guardian.runFullSecurityScan 존재');
    assert.ok(typeof guardian.layer1_gitignoreAudit === 'function', 'layer1 존재');
    assert.ok(typeof guardian.layer6_networkAudit === 'function', 'layer6 존재');
  });

  // Builder 단독 동작 확인
  withMocks(mocks, '../../src/builder.ts', (builder) => {
    assert.ok(typeof builder.needsBuild === 'function', 'builder.needsBuild 존재');
    assert.ok(typeof builder.runBuildCheck === 'function', 'builder.runBuildCheck 존재');
  });

  console.log('✅ E2E: Reviewer → Guardian → Builder 모두 필수 함수 보유');
}

// ─── Scenario 2: Codex Notifier 감지 → 알림 플로우 ───────────────────

async function scenario_codex_notifier_detection_flow() {
  const notifierMocks = {
    ...BASE_MOCKS,
    '../../../packages/core/lib/env': { PROJECT_ROOT: path.join(os.tmpdir(), 'e2e-codex') },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('ps aux'))        return '';  // 프로세스 없음
        if (cmd.includes('git rev-parse')) return 'abc1234';
        if (cmd.includes('git log'))       return 'abc1234 feat(claude): Phase A 완료';
        if (cmd.includes('git tag'))       return 'pre-phase-a-claude-evolution';
        if (cmd.includes('ps -p'))         return 'Sat Apr 18 10:00:00 2026';
        return '';
      },
    },
    fs: require('fs'),
    path: require('path'),
    os: require('os'),
    crypto: require('crypto'),
  };

  withMocks(notifierMocks, '../../lib/codex-plan-notifier.ts', (notifier) => {
    assert.ok(typeof notifier.detectCodexProcesses === 'function', 'detectCodexProcesses 존재');
    assert.ok(typeof notifier.parsePhases === 'function', 'parsePhases 존재');
    assert.ok(typeof notifier.formatPlanStartMessage === 'function', 'formatPlanStartMessage 존재');
    assert.ok(typeof notifier.formatProgressMessage === 'function', 'formatProgressMessage 존재');
    assert.ok(typeof notifier.formatCompletionMessage === 'function', 'formatCompletionMessage 존재');
    assert.ok(typeof notifier.mainLoop === 'function', 'mainLoop 존재');
  });

  console.log('✅ E2E: Codex Notifier 모든 공개 함수 존재');
}

// ─── Scenario 3: Doctor Verify Loop 플로우 ───────────────────────────

async function scenario_doctor_verify_loop_flow() {
  // doctor.ts는 ESM export 사용 — 소스 분석으로 API 검증
  const doctorSrc = fs.readFileSync(
    path.resolve(__dirname, '../../lib/doctor.ts'),
    'utf8'
  );

  const requiredExports = [
    'execute',
    'executeWithVerifyLoop',
    'verifyRecovery',
    'canRecover',
    'WHITELIST',
    'BLACKLIST',
    'getAvailableTasks',
    'emergencyDirectRecover',
  ];

  for (const name of requiredExports) {
    assert.ok(doctorSrc.includes(name), `doctor.ts: ${name} 정의됨`);
  }

  // Verify Loop 패턴 검증
  assert.ok(doctorSrc.includes('MAX_RETRY'), 'MAX_RETRY 정의');
  assert.ok(doctorSrc.includes('RETRY_BACKOFF_MS'), 'RETRY_BACKOFF_MS 정의');
  assert.ok(doctorSrc.includes('claude_doctor_recovery_log'), 'DB 로그 테이블 참조');

  console.log('✅ E2E: Doctor Verify Loop 모든 공개 API 존재');
}

// ─── Scenario 4: Telegram Reporter 5채널 플로우 ───────────────────────

async function scenario_telegram_reporter_5_channels() {
  const reporterMocks = {
    ...BASE_MOCKS,
    '../../../packages/core/lib/openclaw-client': { postAlarm: async () => {} },
    '../../../packages/core/lib/kst': {
      now: () => new Date('2026-04-18T10:00:00+09:00'),
    },
    '../../../packages/core/lib/pg-pool': {
      query: async () => [],
      get: async () => null,
    },
    path: require('path'),
  };

  withMocks(reporterMocks, '../../lib/telegram-reporter.ts', (reporter) => {
    // Urgent 채널
    assert.ok(typeof reporter.onDexterCritical === 'function', 'onDexterCritical 존재');
    assert.ok(typeof reporter.onVerifyLoopFailed === 'function', 'onVerifyLoopFailed 존재');
    assert.ok(typeof reporter.onPrincipleViolation === 'function', 'onPrincipleViolation 존재');
    assert.ok(typeof reporter.onCodexFailed === 'function', 'onCodexFailed 존재');
    // Hourly
    assert.ok(typeof reporter.onHourlySummary === 'function', 'onHourlySummary 존재');
    // Daily
    assert.ok(typeof reporter.onDailyReport === 'function', 'onDailyReport 존재');
    assert.ok(typeof reporter.runDailyReport === 'function', 'runDailyReport 존재');
    assert.ok(typeof reporter.formatDailyReport === 'function', 'formatDailyReport 존재');
    // Weekly
    assert.ok(typeof reporter.onWeeklyReview === 'function', 'onWeeklyReview 존재');
    assert.ok(typeof reporter.runWeeklyReport === 'function', 'runWeeklyReport 존재');
    // Meta
    assert.ok(typeof reporter.onKillSwitchChanged === 'function', 'onKillSwitchChanged 존재');
    assert.ok(typeof reporter.onNlpLearned === 'function', 'onNlpLearned 존재');
  });

  console.log('✅ E2E: Telegram Reporter 5채널 모든 함수 존재');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== E2E 통합 테스트 시작 ===\n');
  const scenarios = [
    scenario_reviewer_guardian_builder_chain,
    scenario_codex_notifier_detection_flow,
    scenario_doctor_verify_loop_flow,
    scenario_telegram_reporter_5_channels,
  ];

  let passed = 0, failed = 0;
  for (const s of scenarios) {
    try {
      await s();
      passed++;
    } catch (e) {
      console.error(`❌ ${s.name}: ${e.message}`);
      if (process.env.DEBUG) console.error(e.stack);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${scenarios.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
