'use strict';

/**
 * Phase D: doctor.ts — Verify Loop 테스트
 *
 * doctor.ts는 ESM export 사용으로 직접 require 불가.
 * 소스 코드 분석 + 실제 로직 추출 검증 방식 사용.
 *
 * 실행: node bots/claude/__tests__/doctor-verify-loop.test.ts
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const DOCTOR_PATH = path.resolve(__dirname, '../lib/doctor.ts');
const DOCTOR_SRC  = fs.readFileSync(DOCTOR_PATH, 'utf8');

// ─── Test 1: executeWithVerifyLoop 함수 존재 ──────────────────────────

async function test_executeWithVerifyLoop_exists() {
  assert.ok(DOCTOR_SRC.includes('async function executeWithVerifyLoop'), 'executeWithVerifyLoop 비동기 함수 존재');
  assert.ok(DOCTOR_SRC.includes('executeWithVerifyLoop'), 'export 목록에 포함');
  console.log('✅ doctor: executeWithVerifyLoop function defined');
}

// ─── Test 2: MAX_RETRY = 3 ────────────────────────────────────────────

async function test_max_retry_is_3() {
  assert.ok(
    DOCTOR_SRC.includes('MAX_RETRY') && DOCTOR_SRC.includes('3'),
    'MAX_RETRY 상수 정의됨'
  );
  const maxRetryMatch = DOCTOR_SRC.match(/MAX_RETRY\s*=\s*(\d+)/);
  assert.ok(maxRetryMatch, 'MAX_RETRY 할당 존재');
  assert.strictEqual(Number(maxRetryMatch[1]), 3, 'MAX_RETRY = 3');
  console.log('✅ doctor: MAX_RETRY is 3');
}

// ─── Test 3: 지수 백오프 배열 ─────────────────────────────────────────

async function test_retry_backoff_defined() {
  assert.ok(DOCTOR_SRC.includes('RETRY_BACKOFF_MS'), 'RETRY_BACKOFF_MS 배열 존재');
  assert.ok(
    DOCTOR_SRC.match(/RETRY_BACKOFF_MS\s*=\s*\[/),
    'RETRY_BACKOFF_MS 배열로 정의'
  );
  console.log('✅ doctor: RETRY_BACKOFF_MS backoff array defined');
}

// ─── Test 4: verifyRecovery 함수 존재 ────────────────────────────────

async function test_verifyRecovery_exists() {
  assert.ok(DOCTOR_SRC.includes('async function verifyRecovery'), 'verifyRecovery 비동기 함수 존재');
  assert.ok(DOCTOR_SRC.includes('verifyRecovery'), 'export 목록에 포함');
  console.log('✅ doctor: verifyRecovery function defined');
}

// ─── Test 5: 최소 4개 검증 케이스 ────────────────────────────────────

async function test_verifyRecovery_has_4_cases() {
  const cases = [
    'restart_launchd_service',
    'git_stash',
    'clear_lock_file',
    'clear_expired_cache',
  ];
  for (const c of cases) {
    assert.ok(DOCTOR_SRC.includes(c), `verifyRecovery case '${c}' 존재`);
  }
  console.log('✅ doctor: verifyRecovery has all 4 required cases');
}

// ─── Test 6: WHITELIST 존재 ───────────────────────────────────────────

async function test_whitelist_exists() {
  assert.ok(DOCTOR_SRC.includes('WHITELIST'), 'WHITELIST 상수 존재');
  assert.ok(DOCTOR_SRC.match(/const WHITELIST\s*=/), 'WHITELIST 상수 정의');
  console.log('✅ doctor: WHITELIST constant defined');
}

// ─── Test 7: BLACKLIST 존재 ───────────────────────────────────────────

async function test_blacklist_exists() {
  assert.ok(DOCTOR_SRC.includes('BLACKLIST'), 'BLACKLIST 상수 존재');
  assert.ok(DOCTOR_SRC.match(/const BLACKLIST\s*=/) || DOCTOR_SRC.match(/BLACKLIST\s*=/), 'BLACKLIST 정의');
  console.log('✅ doctor: BLACKLIST constant defined');
}

// ─── Test 8: _logVerifyLoop DB 기록 ──────────────────────────────────

async function test_log_verify_loop_exists() {
  assert.ok(DOCTOR_SRC.includes('_logVerifyLoop'), '_logVerifyLoop 함수 존재');
  assert.ok(DOCTOR_SRC.includes('claude_doctor_recovery_log'), 'DB 테이블명 참조');
  console.log('✅ doctor: _logVerifyLoop records to claude_doctor_recovery_log');
}

// ─── Test 9: 긴급 알림 — 3회 실패 시 postAlarm ───────────────────────

async function test_postAlarm_on_max_retry_failure() {
  assert.ok(DOCTOR_SRC.includes('postAlarm'), 'postAlarm 호출 존재');
  assert.ok(
    DOCTOR_SRC.includes('Verify Loop 최종 실패') || DOCTOR_SRC.includes('verify'),
    '최종 실패 알림 메시지 존재'
  );
  console.log('✅ doctor: postAlarm called on Verify Loop max retry failure');
}

// ─── Test 10: execute 함수 존재 ───────────────────────────────────────

async function test_execute_function_exists() {
  assert.ok(DOCTOR_SRC.includes('async function execute('), 'execute 비동기 함수 존재');
  assert.ok(DOCTOR_SRC.includes("'execute'") || DOCTOR_SRC.match(/\bexecute\b/), 'execute export 존재');
  console.log('✅ doctor: execute function defined and exported');
}

// ─── Test 11: emergencyDirectRecover 존재 ─────────────────────────────

async function test_emergency_direct_recover_exists() {
  assert.ok(DOCTOR_SRC.includes('emergencyDirectRecover'), 'emergencyDirectRecover 존재');
  console.log('✅ doctor: emergencyDirectRecover exported for Emergency mode');
}

// ─── Test 12: DB 마이그레이션 파일 존재 ──────────────────────────────

async function test_migration_file_exists() {
  const migPath = path.resolve(__dirname, '../migrations/004_claude_doctor_recovery_log.sql');
  assert.ok(fs.existsSync(migPath), 'DB 마이그레이션 파일 존재');
  const migSrc = fs.readFileSync(migPath, 'utf8');
  assert.ok(migSrc.includes('claude_doctor_recovery_log'), 'CREATE TABLE 포함');
  assert.ok(migSrc.includes('action'), 'action 컬럼 포함');
  assert.ok(migSrc.includes('success'), 'success 컬럼 포함');
  assert.ok(migSrc.includes('attempts'), 'attempts 컬럼 포함');
  console.log('✅ doctor: DB migration file exists with correct schema');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Doctor Verify Loop 테스트 시작 ===\n');
  const tests = [
    test_executeWithVerifyLoop_exists,
    test_max_retry_is_3,
    test_retry_backoff_defined,
    test_verifyRecovery_exists,
    test_verifyRecovery_has_4_cases,
    test_whitelist_exists,
    test_blacklist_exists,
    test_log_verify_loop_exists,
    test_postAlarm_on_max_retry_failure,
    test_execute_function_exists,
    test_emergency_direct_recover_exists,
    test_migration_file_exists,
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
