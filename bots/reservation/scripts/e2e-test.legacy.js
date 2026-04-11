#!/usr/bin/env node
/**
 * scripts/e2e-test.js — 스카봇 E2E 통합 테스트 (SKA-P06)
 *
 * 루나팀 dry-run-test.js 패턴 적용.
 * Playwright/픽코/네이버 실제 연결 없이 내부 모듈 전체 검증.
 *
 * 실행:
 *   TELEGRAM_ENABLED=0 node bots/reservation/scripts/e2e-test.js
 *
 * 테스트 단계:
 *   1. secrets 로드 + 필수 키 검증
 *   2. DB 초기화 + 스키마 확인
 *   3. DB 읽기/쓰기 (reservation CRUD)
 *   4. 암호화/복호화 (lib/crypto)
 *   5. 유효성 검증 (lib/validation)
 *   6. 포매팅 (lib/formatting)
 *   7. 연속 오류 카운터 (lib/error-tracker)
 *   8. 텔레그램 suppressed 발송
 *   9. 마이그레이션 상태 확인
 */

process.env.TELEGRAM_ENABLED = '0'; // 실제 텔레그램 발송 차단

const path = require('path');

let passed = 0;
let failed = 0;

function setModeForTest(value) {
  if (value == null) Reflect.deleteProperty(process.env, 'MODE');
  else Reflect.set(process.env, 'MODE', value);
}

function step(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { console.log('✅'); passed++; })
        .catch(e => { console.log(`❌ ${e.message}`); failed++; });
    }
    console.log('✅');
    passed++;
  } catch (e) {
    console.log(`❌ ${e.message}`);
    failed++;
  }
  return Promise.resolve();
}

async function runTests() {
  console.log('\n🧪 스카봇 E2E 통합 테스트 시작\n');
  console.log('─'.repeat(40));

  // ─── 1. Secrets ───────────────────────────────────────────
  console.log('\n[1] Secrets 검증');
  const { loadSecrets, getSecret } = require('../lib/secrets');
  let secrets;

  await step('secrets.json 로드', () => {
    secrets = loadSecrets();
    if (!secrets || typeof secrets !== 'object') throw new Error('secrets 객체 로드 실패');
  });

  await step('필수 키 존재 확인 (pickko_id, telegram_bot_token)', () => {
    const required = ['pickko_id', 'pickko_pw', 'telegram_bot_token', 'telegram_chat_id'];
    for (const k of required) {
      if (!secrets[k]) throw new Error(`필수 키 누락: ${k}`);
    }
  });

  await step('getSecret 기본값 폴백', () => {
    const val = getSecret('nonexistent_key_xyz', 'fallback_value');
    if (val !== 'fallback_value') throw new Error(`폴백 반환 실패: ${val}`);
  });

  // ─── 2. DB 초기화 ──────────────────────────────────────────
  console.log('\n[2] DB 초기화');
  const { getDb, addReservation, getReservation, markSeen, isSeenId,
          addCancelledKey, isCancelledKey } = require('../lib/db');
  let db;

  await step('DB 연결', () => {
    db = getDb();
    if (!db) throw new Error('DB 연결 실패');
  });

  await step('필수 테이블 존재 확인', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map(r => r.name);
    for (const t of ['reservations', 'cancelled_keys', 'kiosk_blocks', 'schema_migrations']) {
      if (!tables.includes(t)) throw new Error(`테이블 없음: ${t}`);
    }
  });

  // ─── 3. DB 읽기/쓰기 ──────────────────────────────────────
  console.log('\n[3] DB CRUD');
  const TEST_ID = `e2e-test-${Date.now()}`;

  await step('markSeen + isSeenId', () => {
    if (isSeenId(TEST_ID)) throw new Error('테스트 ID가 이미 존재');
    markSeen(TEST_ID);
    if (!isSeenId(TEST_ID)) throw new Error('markSeen 후 isSeenId 실패');
  });

  await step('addReservation + getReservation', () => {
    addReservation(TEST_ID, {
      name: '테스트고객', phone: '01012345678', room: '스터디룸A',
      date: '2099-01-01', start: '10:00', end: '12:00',
      status: 'pending', source: 'e2e-test',
    });
    const r = getReservation(TEST_ID);
    if (!r) throw new Error('getReservation 반환값 없음');
    if (r.name !== '테스트고객') throw new Error(`이름 불일치: ${r.name}`);
  });

  await step('addCancelledKey + isCancelledKey', () => {
    const key = `cancel|e2e|test|${Date.now()}`;
    addCancelledKey(key);
    if (!isCancelledKey(key)) throw new Error('cancelledKey 저장 실패');
  });

  // ─── 4. 암호화/복호화 ─────────────────────────────────────
  console.log('\n[4] 암호화');
  const { encrypt, decrypt } = require('../lib/crypto');

  await step('encrypt + decrypt 왕복', () => {
    const plain = '01012345678';
    const enc = encrypt(plain);
    if (!enc || enc === plain) throw new Error('암호화 실패');
    const dec = decrypt(enc);
    if (dec !== plain) throw new Error(`복호화 불일치: ${dec}`);
  });

  await step('빈 문자열 암호화 처리', () => {
    const enc = encrypt('');
    const dec = decrypt(enc);
    if (dec !== '') throw new Error(`빈 문자열 복호화 실패: "${dec}"`);
  });

  // ─── 5. 유효성 검증 ───────────────────────────────────────
  console.log('\n[5] 유효성 검증');
  const { transformAndNormalizeData, validateTimeRange } = require('../lib/validation');

  await step('validateTimeRange 정상 범위', () => {
    const result = validateTimeRange('09:00', '10:00');
    if (!result.ok || result.isCrossMidnight) throw new Error('정상 범위 검증 실패');
  });

  await step('validateTimeRange 자정 초과 감지', () => {
    const result = validateTimeRange('23:00', '01:00');
    if (!result.isCrossMidnight) throw new Error('자정 초과 미감지');
  });

  await step('transformAndNormalizeData 호출 가능', () => {
    if (typeof transformAndNormalizeData !== 'function') throw new Error('함수 아님');
  });

  // ─── 6. 포매팅 ────────────────────────────────────────────
  console.log('\n[6] 포매팅');
  const { maskPhone, maskName } = require('../lib/formatting');

  await step('maskPhone 마스킹', () => {
    const masked = maskPhone('01012345678');
    if (masked === '01012345678') throw new Error('마스킹 미적용');
    if (!masked.includes('*')) throw new Error(`마스킹 형식 오류: ${masked}`);
  });

  await step('maskName 마스킹', () => {
    const masked = maskName('홍길동');
    if (masked === '홍길동') throw new Error('마스킹 미적용');
  });

  // ─── 7. 연속 오류 카운터 ──────────────────────────────────
  console.log('\n[7] 연속 오류 카운터');
  const { createErrorTracker } = require('../lib/error-tracker');

  await step('인메모리 카운터 fail/success', async () => {
    const tracker = createErrorTracker({ label: 'e2e-test', threshold: 3 });
    await tracker.fail(new Error('테스트 오류 1'));
    await tracker.fail('테스트 오류 2');
    if (tracker.getCount() !== 2) throw new Error(`카운터 오류: ${tracker.getCount()}`);
    tracker.success();
    if (tracker.getCount() !== 0) throw new Error('success 후 카운터 미초기화');
  });

  await step('영속 카운터 파일 저장/복원', async () => {
    const t1 = createErrorTracker({ label: 'e2e-persist-test', threshold: 5, persist: true });
    await t1.fail('persist test 1');
    const t2 = createErrorTracker({ label: 'e2e-persist-test', threshold: 5, persist: true });
    if (t2.getCount() !== 1) throw new Error(`복원 실패: count=${t2.getCount()}`);
    t2.success();
    if (t2.getCount() !== 0) throw new Error('success 후 파일 미삭제');
  });

  // ─── 8. OpenClaw topic 알림 (publishReservationAlert) ─────────────
  console.log('\n[8] OpenClaw topic 알림 (publishReservationAlert)');
  const { publishReservationAlert } = require('../lib/alert-client');

  await step('publishReservationAlert 전달 확인', () => {
    const result = publishReservationAlert({ from_bot: 'ska', event_type: 'health_check', alert_level: 1, message: 'E2E 테스트 메시지' });
    if (result !== true) throw new Error(`예상 결과: true, 실제: ${result}`);
  });

  // ─── 9. 모드/환경 분리 ────────────────────────────────────
  console.log('\n[9] 모드/환경 분리');
  const { getMode, isOpsMode: checkOpsMode, printModeBanner, guardRealAction } = require('../lib/mode');

  await step('getMode() 기본값 dev', () => {
    setModeForTest(null);
    const mode = getMode();
    if (mode !== 'dev') throw new Error(`기본 모드 오류: ${mode}`);
  });

  await step('MODE=ops 감지', () => {
    setModeForTest('ops');
    if (!checkOpsMode()) throw new Error('ops 감지 실패');
    setModeForTest(null);
    if (checkOpsMode()) throw new Error('dev 복원 실패');
  });

  await step('printModeBanner 호출 가능', () => {
    if (typeof printModeBanner !== 'function') throw new Error('함수 아님');
    printModeBanner(); // 출력만 확인 (throw 없으면 통과)
  });

  await step('guardRealAction DEV 차단', () => {
    setModeForTest(null); // dev 모드 강제
    try {
      guardRealAction('e2e-테스트-액션');
      throw new Error('차단되어야 했으나 통과됨');
    } catch (e) {
      if (!e.message.includes('실동작 차단')) throw e; // 다른 에러라면 재throw
    }
  });

  // ─── 10. 프로세스 상태 파일 ───────────────────────────────
  console.log('\n[10] 프로세스 상태 파일');
  const { recordHeartbeat: recHB, getStatus, markStopped } = require('../lib/status');

  await step('recordHeartbeat running 기록', () => {
    recHB({ status: 'running' });
    const s = getStatus();
    if (s.status !== 'running') throw new Error(`status 오류: ${s.status}`);
    if (!s.checkCount || s.checkCount < 1) throw new Error(`checkCount 오류: ${s.checkCount}`);
  });

  await step('recordHeartbeat idle 전환', () => {
    recHB({ status: 'idle' });
    const s = getStatus();
    if (s.status !== 'idle') throw new Error(`idle 전환 실패: ${s.status}`);
    if (s.consecutiveErrors !== 0) throw new Error(`consecutiveErrors 미초기화: ${s.consecutiveErrors}`);
  });

  await step('recordHeartbeat error 기록', () => {
    recHB({ status: 'error', error: new Error('e2e 테스트 오류') });
    const s = getStatus();
    if (s.status !== 'error') throw new Error(`error 기록 실패: ${s.status}`);
    if (!s.lastError) throw new Error('lastError 없음');
    if (s.consecutiveErrors < 1) throw new Error(`consecutiveErrors 증가 실패: ${s.consecutiveErrors}`);
  });

  await step('markStopped 정상 종료', () => {
    markStopped({ reason: 'e2e 테스트 완료' });
    const s = getStatus();
    if (s.pid !== null) throw new Error(`pid 미초기화: ${s.pid}`);
    if (s.status !== 'idle') throw new Error(`종료 후 status 오류: ${s.status}`);
  });

  // ─── 11. 3중 가동/중지 (health.js) ───────────────────────
  console.log('\n[11] 3중 가동/중지');
  const {
    preflightSystemCheck, setShuttingDown, isShuttingDown: checkShutdown,
    shutdownDB, shutdownCleanup,
  } = require('../lib/health');

  await step('preflightSystemCheck (2중) 통과', async () => {
    // OPS 가드 체크가 있으므로 MODE=ops 설정
    setModeForTest('ops');
    try {
      await preflightSystemCheck();
    } finally {
      setModeForTest(null);
    }
  });

  await step('setShuttingDown / isShuttingDown 플래그', () => {
    // health.js는 모듈 수준 상태라 별도 인스턴스 필요
    // 여기선 export 된 함수 동작만 확인
    if (typeof setShuttingDown !== 'function') throw new Error('setShuttingDown 함수 아님');
    if (typeof checkShutdown !== 'function')   throw new Error('isShuttingDown 함수 아님');
  });

  await step('shutdownDB 호출 가능 (rollback 0건)', async () => {
    await shutdownDB(); // 테스트용 processing 항목 없음 → 0건 정상
  });

  await step('shutdownCleanup 호출 가능 (텔레그램 suppressed)', async () => {
    await shutdownCleanup({ reason: 'e2e 테스트', error: false, locks: [] });
  });

  // ─── 12. 마이그레이션 상태 ────────────────────────────────
  console.log('\n[12] 마이그레이션 상태');

  await step('schema_migrations 테이블 존재 (12)', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map(r => r.name);
    if (!tables.includes('schema_migrations')) throw new Error('schema_migrations 없음');
  });

  await step('적용된 마이그레이션 1개 이상 (12)', () => {
    const rows = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    if (rows.length === 0) throw new Error('마이그레이션 적용 기록 없음');
  });

  // ─── 결과 ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(40));
  const total = passed + failed;
  console.log(`\n📊 결과: ${passed}/${total} 통과`);
  if (failed === 0) {
    console.log('🎉 전체 통과\n');
    process.exit(0);
  } else {
    console.log(`❌ ${failed}건 실패\n`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error(`\n❌ 테스트 런타임 오류: ${err.message}`);
  process.exit(1);
});
