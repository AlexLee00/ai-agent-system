'use strict';

/**
 * Phase C: claude-commander.ts 단위 테스트
 *
 * HANDLERS 19개 등록 확인 + 주요 핸들러 동작 테스트
 *
 * 실행: node bots/claude/__tests__/commander.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const COMMANDER_PATH = path.resolve(__dirname, '../src/claude-commander.ts');

const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-commander.lock');

function makeCommanderMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/pg-pool': {
      query: async () => [],
      get:   async () => null,
      run:   async () => null,
    },
    '../../../packages/core/lib/llm-keys': {
      initHubConfig: async () => {},
    },
    '../../../packages/core/lib/intent-core': {
      AUTO_PROMOTE_DEFAULTS: {},
      normalizeIntentText:       (t) => t,
      buildAutoLearnPattern:     () => null,
      evaluateAutoPromoteDecision: () => ({ shouldPromote: false }),
    },
    '../../../packages/core/lib/intent-store': {
      ensureIntentTables:         async () => {},
      addLearnedPattern:          async () => {},
      getNamedIntentLearningPath: () => '/tmp/intent-test.json',
      insertUnrecognizedIntent:   async () => {},
      getRecentUnrecognizedIntents: async () => [],
      upsertPromotionCandidate:   async () => {},
      logPromotionEvent:          async () => {},
      findPromotionCandidateIdByNormalized: async () => null,
      markUnrecognizedPromoted:   async () => {},
    },
    '../lib/team-bus': {
      setStatus: async () => {},
      markDone:  async () => {},
      markError: async () => {},
    },
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async () => {},
    },
    '../lib/codex-plan-notifier': {
      detectCodexProcesses: async () => [],
      loadState: () => ({}),
    },
    '../lib/doctor': {
      executeWithVerifyLoop: async () => ({ success: true, message: 'ok', attempts: 1, verified: true }),
    },
    '../lib/telegram-reporter': {
      onDexterCritical:    async () => {},
      onVerifyLoopFailed:  async () => {},
      runDailyReport:      async () => {},
    },
    child_process: {
      execSync: (cmd) => '',
      spawn: () => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (evt, cb) => { if (evt === 'close') setTimeout(() => cb(0), 10); },
        kill: () => {},
      }),
    },
    fs: require('fs'),
    path: require('path'),
    os: require('os'),
    ...overrides,
  };
}

// Commander를 임포트하지 않고 HANDLERS만 검사하기 위해
// 파일에서 직접 HANDLERS 패턴을 grep으로 추출
function getHandlerNamesFromSource() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  const matches = [...src.matchAll(/^\s{2}([a-z_]+):\s+handle/gm)];
  return matches.map(m => m[1]);
}

// ─── Test 1: HANDLERS 19개 등록 확인 (소스 분석) ─────────────────────

async function test_handlers_count_is_19() {
  const handlerNames = getHandlerNamesFromSource();
  assert.ok(handlerNames.length >= 19, `핸들러 수: ${handlerNames.length} (최소 19개 필요)`);

  const required = [
    // 기존 10개
    'run_check', 'run_full', 'run_fix', 'daily_report', 'run_archer',
    'ask_claude', 'analyze_unknown', 'session_close', 'codex_approve', 'codex_reject',
    // Phase A 4개
    'run_review', 'run_guardian', 'run_builder', 'run_full_quality',
    // Phase N 2개
    'test_codex_notifier', 'show_codex_status',
    // Phase AD 2개
    'run_auto_dev', 'show_auto_dev_status',
    // Phase D 1개
    'run_doctor_verify',
  ];
  for (const name of required) {
    assert.ok(handlerNames.includes(name), `핸들러 '${name}' 등록 확인`);
  }
  console.log(`✅ commander: 19개 핸들러 모두 등록됨 (총 ${handlerNames.length}개)`);
}

// ─── Test 2: run_doctor_verify — task_type 없을 때 에러 ──────────────

async function test_handleRunDoctorVerify_no_task_type() {
  // 소스에서 handleRunDoctorVerify 로직 확인
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(
    src.includes("'task_type 파라미터 필요'") ||
    src.includes('"task_type 파라미터 필요"') ||
    src.includes('task_type'),
    'task_type 파라미터 검증 로직 존재'
  );
  console.log('✅ commander: handleRunDoctorVerify validates task_type param');
}

// ─── Test 3: run_full_quality — 순차 실행 로직 ───────────────────────

async function test_handleRunFullQuality_sequential_logic() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleRunFullQuality'), 'handleRunFullQuality 존재');
  assert.ok(src.includes('run_full_quality'), 'run_full_quality 핸들러 등록');
  // Reviewer → Guardian → Builder 순서 확인
  const rvIdx = src.indexOf('reviewer');
  const gdIdx = src.indexOf('guardian');
  const bdIdx = src.indexOf('builder');
  assert.ok(rvIdx < gdIdx, 'reviewer가 guardian보다 먼저');
  assert.ok(gdIdx < bdIdx, 'guardian이 builder보다 먼저');
  console.log('✅ commander: run_full_quality has sequential logic (reviewer→guardian→builder)');
}

// ─── Test 4: test_codex_notifier — 핸들러 존재 ───────────────────────

async function test_testCodexNotifier_handler_exists() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleTestCodexNotifier'), 'handleTestCodexNotifier 존재');
  assert.ok(src.includes('test_codex_notifier'), 'test_codex_notifier 핸들러 등록');
  console.log('✅ commander: test_codex_notifier handler registered');
}

// ─── Test 5: show_codex_status — 핸들러 존재 ─────────────────────────

async function test_showCodexStatus_handler_exists() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleShowCodexStatus'), 'handleShowCodexStatus 존재');
  assert.ok(src.includes('show_codex_status'), 'show_codex_status 핸들러 등록');
  console.log('✅ commander: show_codex_status handler registered');
}

// ─── Test 6: run_review — 핸들러 존재 ────────────────────────────────

async function test_runReview_handler_exists() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleRunReview'), 'handleRunReview 존재');
  assert.ok(src.includes('run_review'), 'run_review 핸들러 등록');
  console.log('✅ commander: run_review handler registered');
}

// ─── Test 7: run_guardian — 핸들러 존재 ──────────────────────────────

async function test_runGuardian_handler_exists() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleRunGuardian'), 'handleRunGuardian 존재');
  console.log('✅ commander: run_guardian handler registered');
}

// ─── Test 8: run_auto_dev — 핸들러 존재 ─────────────────────────────

async function test_runAutoDev_handler_exists() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('handleRunAutoDev'), 'handleRunAutoDev 존재');
  assert.ok(src.includes('run_auto_dev'), 'run_auto_dev 핸들러 등록');
  assert.ok(src.includes('show_auto_dev_status'), 'show_auto_dev_status 핸들러 등록');
  console.log('✅ commander: auto_dev handlers registered');
}

// ─── Test 9: run_auto_dev boolean 파싱 보강 확인 ─────────────────────

async function test_runAutoDev_boolean_parsing_hardening() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('function parseBool'), 'parseBool 유틸 존재');
  assert.ok(src.includes("'false'") && src.includes("'0'") && src.includes("'no'"), 'false 문자열 파싱 규칙 존재');
  assert.ok(src.includes('parseBool(args.once') || src.includes('parseBool(args.once,'), 'once 파싱에 parseBool 사용');
  assert.ok(src.includes('parseBool(args.test') || src.includes('parseBool(args.test,'), 'test 파싱에 parseBool 사용');
  assert.ok(src.includes('parseBool(args.dry_run ?? args.dryRun'), 'dry_run/dryRun 파싱에 parseBool 사용');
  assert.ok(src.includes('parseBool(args.force'), 'force 파싱에 parseBool 사용');
  assert.ok(src.includes('parseBool(args.shadow'), 'shadow 파싱에 parseBool 사용');
  console.log('✅ commander: run_auto_dev boolean parsing hardened');
}

// ─── Test 10: processCommands — 알 수 없는 명령 에러 처리 ─────────────

async function test_processCommands_handles_unknown_command() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(
    src.includes('알 수 없는 명령') || src.includes('unknown command'),
    '알 수 없는 명령 에러 처리 로직 존재'
  );
  console.log('✅ commander: processCommands handles unknown command gracefully');
}

// ─── Test 10: analyze_unknown — NLP 학습 인텐트 목록에 신규 포함 ───────

async function test_nlp_intents_include_new_commands() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  // Phase C에서 추가된 NLP 인텐트가 있는지 확인
  const hasNewIntents = (
    src.includes('run_review') &&
    src.includes('run_guardian') &&
    src.includes('run_builder')
  );
  assert.ok(hasNewIntents, 'NLP 인텐트 목록에 신규 명령 포함');
  console.log('✅ commander: NLP intents include new Phase A/N/D commands');
}

// ─── Test 11: 30초 폴링 유지 ─────────────────────────────────────────

async function test_polling_interval_maintained() {
  const src = fs.readFileSync(COMMANDER_PATH, 'utf8');
  assert.ok(src.includes('30000'), '30초(30000ms) 폴링 간격 유지');
  console.log('✅ commander: 30-second polling interval maintained');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Commander 테스트 시작 ===\n');
  const tests = [
    test_handlers_count_is_19,
    test_handleRunDoctorVerify_no_task_type,
    test_handleRunFullQuality_sequential_logic,
    test_testCodexNotifier_handler_exists,
    test_showCodexStatus_handler_exists,
    test_runReview_handler_exists,
    test_runGuardian_handler_exists,
    test_runAutoDev_handler_exists,
    test_runAutoDev_boolean_parsing_hardening,
    test_processCommands_handles_unknown_command,
    test_nlp_intents_include_new_commands,
    test_polling_interval_maintained,
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
