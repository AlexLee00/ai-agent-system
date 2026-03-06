#!/usr/bin/env node

/**
 * test-nlp-e2e.js — 자연어 명령 CLI E2E 테스트
 *
 * 사용법:
 *   node src/test-nlp-e2e.js           # 전체 테스트 (검증 레이어 + DB 조회)
 *   node src/test-nlp-e2e.js --verbose  # 각 케이스 message 미리보기 포함
 *
 * 대상 스크립트:
 *   - pickko-query.js      (예약 조회 — DB read)
 *   - pickko-stats-cmd.js  (매출 통계 — DB read)
 *   - pickko-register.js   (예약 등록 — validation layer only)
 *   - pickko-cancel-cmd.js (예약 취소 — validation layer only)
 *
 * 참고: register/cancel의 실제 Playwright 실행 테스트는 이 스크립트 범위 밖 (수동 검증)
 */

const { spawnSync } = require('child_process');
const path = require('path');

const RESERVATION_DIR = path.join(__dirname, '..', 'manual', 'reservation');
const REPORTS_DIR     = path.join(__dirname, '..', 'manual', 'reports');

// 스크립트명 → 디렉토리 매핑 (src/ → manual/ 이전 후 경로 업데이트)
const SCRIPT_DIRS = {
  'pickko-query.js':      RESERVATION_DIR,
  'pickko-register.js':   RESERVATION_DIR,
  'pickko-cancel-cmd.js': RESERVATION_DIR,
  'pickko-stats-cmd.js':  REPORTS_DIR,
};

function resolveScript(script) {
  const dir = SCRIPT_DIRS[script] || RESERVATION_DIR;
  return { scriptPath: path.join(dir, script), cwd: dir };
}

const VERBOSE = process.argv.includes('--verbose');

let passed = 0, failed = 0;
const results = [];

// ── 실행 헬퍼 ────────────────────────────────────────────────────────────────

function run(script, args, timeoutMs = 8000) {
  const { scriptPath, cwd } = resolveScript(script);
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd,
    env: { ...process.env, MODE: 'ops' },
    timeout: timeoutMs,
  });

  let json = null;
  const stdout = result.stdout?.toString().trim() || '';
  try { json = JSON.parse(stdout); } catch {}

  return {
    code:   result.status,
    json,
    stdout,
    stderr: result.stderr?.toString().trim() || '',
    timedOut: result.status === null,
  };
}

// ── 테스트 등록 ───────────────────────────────────────────────────────────────

/**
 * @param {string} name         테스트 이름
 * @param {string} script       실행할 스크립트 파일명
 * @param {string[]} args       CLI 인자 배열
 * @param {object} opts
 *   expectSuccess {boolean}    기대하는 success 값 (기본: true)
 *   checkFields   {string[]}   결과 JSON에 반드시 있어야 할 필드 목록
 *   checkMessage  {RegExp}     message 필드가 매칭해야 할 정규식 (선택)
 */
function test(name, script, args, opts = {}) {
  const {
    expectSuccess = true,
    checkFields   = ['success', 'message'],
    checkMessage  = null,
  } = opts;

  const { json, timedOut, code } = run(script, args);
  const errors = [];

  if (timedOut) {
    errors.push('타임아웃 (Playwright 실행 시작됐을 수 있음)');
  } else if (json === null) {
    errors.push('stdout JSON 파싱 실패');
  } else {
    if (json.success !== expectSuccess) {
      errors.push(`success: 기대 ${expectSuccess}, 실제 ${json.success}`);
    }
    for (const field of checkFields) {
      if (!(field in json)) errors.push(`필드 누락: ${field}`);
    }
    if (checkMessage && typeof json.message === 'string' && !checkMessage.test(json.message)) {
      errors.push(`message 패턴 불일치: ${checkMessage}`);
    }
  }

  const ok = errors.length === 0;
  results.push({ ok, name, errors, json, script, args });
  if (ok) passed++;
  else    failed++;
}

// ══════════════════════════════════════════════════════════════════════════════
// 테스트 케이스
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 자연어 명령 E2E 테스트 시작...\n');

// ── pickko-query.js ──────────────────────────────────────────────────────────
console.log('  [ pickko-query.js ]');

test('query: 오늘 예약 조회',
  'pickko-query.js', ['--date=today'],
  { checkFields: ['success', 'count', 'message', 'bookings'] });

test('query: 내일 예약 조회',
  'pickko-query.js', ['--date=tomorrow'],
  { checkFields: ['success', 'count', 'message', 'bookings'] });

test('query: 특정 날짜 조회',
  'pickko-query.js', ['--date=2026-02-26'],
  { checkFields: ['success', 'count', 'message', 'bookings'] });

test('query: 미래 날짜 (예약 없음)',
  'pickko-query.js', ['--date=2099-12-31'],
  { checkFields: ['success', 'count', 'bookings'],
    checkMessage: /예약 없음/ });

test('query: 이름으로 검색 (없는 이름)',
  'pickko-query.js', ['--name=없는사람테스트'],
  { checkFields: ['success', 'count', 'bookings'],
    checkMessage: /예약 없음/ });

test('query: 전화번호로 검색',
  'pickko-query.js', ['--phone=01099999999'],
  { checkFields: ['success', 'count', 'bookings'] });

test('query: 룸 필터',
  'pickko-query.js', ['--room=A1'],
  { checkFields: ['success', 'count', 'bookings'] });

test('query: 날짜+룸 복합 필터',
  'pickko-query.js', ['--date=today', '--room=B'],
  { checkFields: ['success', 'count', 'bookings'] });

test('query: 잘못된 날짜 형식 → 실패',
  'pickko-query.js', ['--date=잘못된날짜'],
  { expectSuccess: false });

// ── pickko-stats-cmd.js ───────────────────────────────────────────────────────
console.log('\n  [ pickko-stats-cmd.js ]');

test('stats: 오늘 매출',
  'pickko-stats-cmd.js', ['--date=today']);

test('stats: 어제 매출',
  'pickko-stats-cmd.js', ['--date=yesterday']);

test('stats: 특정 날짜 (데이터 있음)',
  'pickko-stats-cmd.js', ['--date=2026-02-26'],
  { checkMessage: /합계/ });

test('stats: 미래 날짜 (데이터 없음)',
  'pickko-stats-cmd.js', ['--date=2099-12-31'],
  { checkMessage: /데이터 없음/ });

test('stats: 이번 주',
  'pickko-stats-cmd.js', ['--period=week'],
  { checkMessage: /이번 주 매출/ });

test('stats: 이번 달',
  'pickko-stats-cmd.js', ['--period=month'],
  { checkMessage: /월 매출/ });

test('stats: 특정 월',
  'pickko-stats-cmd.js', ['--month=2026-02'],
  { checkMessage: /2026년 2월/ });

test('stats: 누적 확정 매출',
  'pickko-stats-cmd.js', ['--cumulative'],
  { checkMessage: /누적 확정 매출/ });

test('stats: 잘못된 period → 실패',
  'pickko-stats-cmd.js', ['--period=invalid'],
  { expectSuccess: false });

test('stats: 잘못된 month 형식 → 실패',
  'pickko-stats-cmd.js', ['--month=잘못된월'],
  { expectSuccess: false });

// ── pickko-register.js (validation layer) ────────────────────────────────────
console.log('\n  [ pickko-register.js — validation layer ]');

test('register: 전체 인자 누락 → 실패',
  'pickko-register.js', [],
  { expectSuccess: false,
    checkMessage: /필수 인자 누락/ });

test('register: phone 누락 → 실패',
  'pickko-register.js',
  ['--date=2026-03-05', '--start=15:00', '--end=17:00', '--room=A1'],
  { expectSuccess: false,
    checkMessage: /필수 인자 누락/ });

test('register: 잘못된 룸 → 실패',
  'pickko-register.js',
  ['--date=2026-03-05', '--start=15:00', '--end=17:00',
   '--room=ZZZ', '--phone=01012345678', '--name=테스트'],
  { expectSuccess: false });

test('register: 잘못된 날짜 형식 → 실패',
  'pickko-register.js',
  ['--date=invalid', '--start=15:00', '--end=17:00',
   '--room=A1', '--phone=01012345678', '--name=테스트'],
  { expectSuccess: false });

// ── pickko-cancel-cmd.js (validation layer) ───────────────────────────────────
console.log('\n  [ pickko-cancel-cmd.js — validation layer ]');

test('cancel: 전체 인자 누락 → 실패',
  'pickko-cancel-cmd.js', [],
  { expectSuccess: false,
    checkMessage: /필수 인자 누락/ });

test('cancel: 잘못된 전화번호 형식 → 실패',
  'pickko-cancel-cmd.js',
  ['--phone=010', '--date=2026-03-05', '--start=15:00', '--end=17:00', '--room=A1'],
  { expectSuccess: false,
    checkMessage: /전화번호 형식 오류/ });

test('cancel: 잘못된 날짜 형식 → 실패',
  'pickko-cancel-cmd.js',
  ['--phone=01012345678', '--date=invalid',
   '--start=15:00', '--end=17:00', '--room=A1'],
  { expectSuccess: false,
    checkMessage: /날짜 형식 오류/ });

test('cancel: 잘못된 룸 → 실패',
  'pickko-cancel-cmd.js',
  ['--phone=01012345678', '--date=2026-03-05',
   '--start=15:00', '--end=17:00', '--room=ZZZ'],
  { expectSuccess: false,
    checkMessage: /유효하지 않은 룸/ });

// ══════════════════════════════════════════════════════════════════════════════
// 결과 출력
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(60));
console.log('  📋 테스트 결과');
console.log('═'.repeat(60));

let lastGroup = null;
for (const r of results) {
  // 스크립트별 그룹 구분선
  const group = r.script;
  if (group !== lastGroup) {
    console.log(`\n  ── ${group} ──`);
    lastGroup = group;
  }

  if (r.ok) {
    const preview = VERBOSE && r.json?.message
      ? `  →  ${r.json.message.split('\n')[0].slice(0, 40)}`
      : '';
    console.log(`  ✅ ${r.name}${preview}`);
  } else {
    console.log(`  ❌ ${r.name}`);
    for (const e of r.errors) {
      console.log(`      → ${e}`);
    }
    if (r.json) {
      console.log(`      message: ${String(r.json.message || '').slice(0, 80)}`);
    }
  }
}

console.log('\n' + '─'.repeat(60));
const total = passed + failed;
const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
console.log(`  통과 ${passed}/${total} (${pct}%)  |  실패 ${failed}`);
console.log('═'.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
