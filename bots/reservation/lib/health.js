'use strict';

/**
 * lib/health.js — 스카봇 3중 가동·3중 중지 관리
 *
 * 루나팀 lib/health.js 패턴 적용.
 *
 * ┌─── 3중 가동 ────────────────────────────────────────────────┐
 * │ 1중 (Shell)  : start-ops.sh — 디스크·네트워크·secrets 파일  │
 * │ 2중 (Node)   : preflightSystemCheck() — DB·스키마·Chrome    │
 * │ 3중 (Conn)   : preflightConnCheck() — 네이버·텔레그램 연결  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * ┌─── 3중 중지 ────────────────────────────────────────────────┐
 * │ 1중 (Signal) : registerShutdownHandlers() — SIGTERM/SIGINT  │
 * │ 2중 (DB)     : shutdownDB() — processing 롤백               │
 * │ 3중 (Cleanup): shutdownCleanup() — lock·status·텔레그램     │
 * └─────────────────────────────────────────────────────────────┘
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ─── 내부 상태 ──────────────────────────────────────────────────────
let _isShuttingDown = false;

// ─── 시작 2중: Node.js 프리플라이트 ────────────────────────────────

/**
 * 시작 2중 체크 (Node.js 레벨)
 * DB 연결·스키마·마이그레이션·Chrome 검증
 * @throws {Error} 검증 실패 시
 */
async function preflightSystemCheck() {
  const errors = [];
  const warns  = [];
  console.log('  🔎 [2중] Node.js 프리플라이트 체크...');

  // 2-1. OPS 모드 가드 (MODE=ops 필수)
  try {
    const { assertOpsReady } = require('./mode');
    assertOpsReady();
    console.log('      ✅ OPS 모드 가드');
  } catch (e) {
    errors.push(`OPS 가드: ${e.message.split('\n')[0]}`);
  }

  // 2-2. secrets.json 필수 키
  try {
    const { hasSecret } = require('./secrets');
    const REQUIRED = ['naver_id', 'naver_pw', 'pickko_id', 'pickko_pw', 'db_encryption_key', 'db_key_pepper'];
    const missing  = REQUIRED.filter(k => !hasSecret(k));
    if (missing.length > 0) {
      errors.push(`secrets.json 필수 키 누락: ${missing.join(', ')}`);
    } else {
      console.log(`      ✅ secrets.json 필수 키 (${REQUIRED.length}개)`);
    }
    if (!hasSecret('telegram_bot_token')) {
      warns.push('telegram_bot_token 미설정 — 텔레그램 알림 비활성화됨');
    }
  } catch (e) {
    errors.push(`secrets 로드 실패: ${e.message}`);
  }

  // 2-3. SQLite DB 파일 존재
  const dbPath = path.join(process.env.HOME, '.openclaw', 'workspace', 'state.db');
  if (!fs.existsSync(dbPath)) {
    errors.push(`DB 파일 없음: ${dbPath} → node scripts/migrate.js 실행 필요`);
  } else {
    const stat = fs.statSync(dbPath);
    console.log(`      ✅ DB 파일 (${(stat.size / 1024).toFixed(0)}KB)`);
  }

  // 2-4. DB 연결 + 필수 테이블
  if (fs.existsSync(dbPath)) {
    try {
      const db = require('./db');
      const rawDb = db.getDb();
      const tables = rawDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all().map(r => r.name);

      const REQUIRED_TABLES = ['reservations', 'daily_summary', 'schema_migrations'];
      const missingTables   = REQUIRED_TABLES.filter(t => !tables.includes(t));
      if (missingTables.length > 0) {
        errors.push(`DB 테이블 누락: ${missingTables.join(', ')} → node scripts/migrate.js 실행 필요`);
      } else {
        console.log(`      ✅ DB 스키마 (${tables.length}개 테이블)`);
      }

      // 미적용 마이그레이션 (경고만)
      try {
        const BOT_DIR = path.join(__dirname, '..');
        const migDir  = path.join(BOT_DIR, 'migrations');
        if (fs.existsSync(migDir)) {
          const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.+\.js$/.test(f));
          db.initMigrationsTable();
          const applied = db.getAppliedMigrations();
          const pending = migFiles.filter(f => {
            const mod = require(path.join(migDir, f));
            return !applied.has(mod.version);
          });
          if (pending.length > 0) warns.push(`미적용 마이그레이션 ${pending.length}개`);
          else console.log('      ✅ DB 마이그레이션 최신');
        }
      } catch (e) { warns.push(`마이그레이션 확인 오류: ${e.message.split('\n')[0]}`); }
    } catch (e) {
      errors.push(`DB 연결 실패: ${e.message.split('\n')[0]}`);
    }
  }

  // 2-5. Puppeteer Chrome 설치 여부
  try {
    const puppeteer = require('puppeteer');
    const chromePath = puppeteer.executablePath();
    if (!chromePath || !fs.existsSync(chromePath)) {
      errors.push('Puppeteer Chrome 없음 → npx puppeteer browsers install chrome');
    } else {
      console.log('      ✅ Puppeteer Chrome');
    }
  } catch (e) {
    errors.push(`Puppeteer 확인 실패: ${e.message.split('\n')[0]}`);
  }

  for (const w of warns) console.warn(`      ⚠️  ${w}`);

  if (errors.length > 0) {
    throw new Error(`[2중 체크 실패]\n${errors.map(e => `  ❌ ${e}`).join('\n')}`);
  }
  console.log('  ✅ [2중] Node.js 프리플라이트 통과');
}

// ─── 시작 3중: API 연결성 체크 ──────────────────────────────────────

/**
 * HTTPS GET 헬퍼 (3중 체크용)
 * @param {string} hostname
 * @param {string} pathname
 * @param {number} timeoutMs
 * @returns {Promise<number>} HTTP 상태 코드
 */
function _httpsGet(hostname, pathname = '/', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path: pathname, timeout: timeoutMs }, res => {
      res.resume(); // 응답 바디 소모 (메모리 누수 방지)
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('연결 타임아웃')); });
    req.on('error', reject);
  });
}

/**
 * 시작 3중 체크 (API 연결성)
 * 네이버·텔레그램 실제 연결 확인
 * @throws {Error} 연결 실패 시
 */
async function preflightConnCheck() {
  const errors = [];
  console.log('  🌐 [3중] API 연결성 체크...');

  // 3-1. 네이버 도달 가능 여부
  try {
    const status = await _httpsGet('naver.com');
    if (status >= 200 && status < 400) {
      console.log(`      ✅ 네이버 연결 (HTTP ${status})`);
    } else {
      errors.push(`네이버 HTTP 응답 이상: ${status}`);
    }
  } catch (e) {
    errors.push(`네이버 연결 실패: ${e.message}`);
  }

  // 3-2. 텔레그램 테스트 발송
  try {
    const { tryTelegramSend } = require('./telegram');
    const ok = await tryTelegramSend('[3중 체크] 스카봇 OPS 시작 — 연결 확인');
    if (ok) {
      console.log('      ✅ 텔레그램 연결');
    } else {
      errors.push('텔레그램 발송 실패 (token 또는 네트워크 확인)');
    }
  } catch (e) {
    errors.push(`텔레그램 체크 오류: ${e.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`[3중 체크 실패]\n${errors.map(e => `  ❌ ${e}`).join('\n')}`);
  }
  console.log('  ✅ [3중] API 연결성 통과');
}

// ─── 종료 1중: Graceful flag ─────────────────────────────────────────

function setShuttingDown() { _isShuttingDown = true; }
function isShuttingDown()  { return _isShuttingDown; }

// ─── 종료 2중: DB 정리 ───────────────────────────────────────────────

/**
 * 종료 2중: processing 예약 롤백
 */
async function shutdownDB() {
  console.log('\n  🗄️  [2중 종료] DB 정리...');
  try {
    const { rollbackProcessing, log: dbLog } = require('./db');
    const count = rollbackProcessing();
    if (count > 0) console.log(`      ✅ processing → failed 롤백 ${count}건`);
    else            console.log('      ✅ 롤백 대상 없음');
  } catch (e) {
    console.error(`      ⚠️  DB 정리 실패: ${e.message}`);
  }
}

// ─── 종료 3중: Lock·Status·텔레그램 ─────────────────────────────────

/**
 * 종료 3중: 파일 정리 + 상태 기록 + 텔레그램 종료 알림
 * @param {object} opts
 * @param {string}   [opts.reason='정상 종료']
 * @param {boolean}  [opts.error=false]
 * @param {string[]} [opts.locks=[]]  삭제할 lock 파일 경로 목록
 */
async function shutdownCleanup({ reason = '정상 종료', error = false, locks = [] } = {}) {
  console.log('  🧹 [3중 종료] 정리...');

  // lock 파일 삭제
  for (const lk of locks) {
    try { fs.unlinkSync(lk); console.log(`      ✅ lock 삭제: ${path.basename(lk)}`); }
    catch { /* 이미 없으면 무시 */ }
  }

  // 상태 파일 갱신
  try {
    const { markStopped } = require('./status');
    markStopped({ reason, error });
    console.log('      ✅ 상태 파일 갱신');
  } catch (e) {
    console.warn(`      ⚠️  상태 파일 갱신 실패: ${e.message}`);
  }

  // 텔레그램 종료 알림
  try {
    const { tryTelegramSend } = require('./telegram');
    const emoji = error ? '❌' : '🏁';
    await tryTelegramSend(`${emoji} [스카봇 OPS] 종료\n사유: ${reason}`);
    console.log('      ✅ 텔레그램 종료 알림');
  } catch (e) {
    console.warn(`      ⚠️  텔레그램 알림 실패: ${e.message}`);
  }

  console.log('  ✅ [3중 종료] 정리 완료');
}

// ─── 통합 Graceful Shutdown 핸들러 ──────────────────────────────────

/**
 * SIGTERM/SIGINT/uncaughtException 핸들러 등록
 * 신호 수신 → graceful shutdown → process.exit
 *
 * @param {object}   opts
 * @param {string[]} [opts.locks=[]]       삭제할 lock 파일 목록
 * @param {number}   [opts.waitMs=15000]   진행 중 작업 대기 시간 (ms)
 */
function registerShutdownHandlers({ locks = [], waitMs = 15000 } = {}) {
  let _handled = false;

  async function onShutdown(signal) {
    if (_handled) return;
    _handled = true;
    setShuttingDown();

    console.log(`\n⚠️  [1중 종료] ${signal} 수신 — graceful shutdown 시작`);
    console.log(`      ⏳ 진행 중 작업 완료 대기 (최대 ${waitMs / 1000}초)...`);

    // 진행 중 사이클 완료 대기
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    await shutdownDB();
    await shutdownCleanup({
      reason: `${signal} 수신`,
      error:  signal !== 'SIGTERM',
      locks,
    });

    process.exit(signal === 'SIGINT' ? 130 : 0);
  }

  process.on('SIGTERM', () => onShutdown('SIGTERM'));
  process.on('SIGINT',  () => onShutdown('SIGINT'));
  process.on('uncaughtException', async (err) => {
    if (_handled) return;
    _handled = true;
    setShuttingDown();
    console.error('\n❌ [uncaughtException]', err.message);
    await shutdownDB();
    await shutdownCleanup({ reason: err.message, error: true, locks });
    process.exit(1);
  });
}

module.exports = {
  // 시작
  preflightSystemCheck,
  preflightConnCheck,
  // 종료
  setShuttingDown,
  isShuttingDown,
  shutdownDB,
  shutdownCleanup,
  registerShutdownHandlers,
};
