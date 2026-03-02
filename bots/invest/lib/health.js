'use strict';

/**
 * lib/health.js — 투자봇 3중 가동 체크 시스템
 *
 * [시작 3중]
 *   1중: preflightSystemCheck()  — DB·스키마·설정·모드 (Node.js)
 *   2중: preflightConnCheck()    — 바이낸스 API 연결·텔레그램 연결 (API)
 *   ※ Shell 레벨(1중)은 start-invest-ops.sh 에서 처리
 *
 * [종료 3중]
 *   1중: setShuttingDown()       — graceful flag 설정 (Signal)
 *   2중: shutdownDB()            — pending 롤백·스냅샷 (DB)
 *   3중: shutdownCleanup()       — lock·파일·텔레그램 (Cleanup)
 *
 * [가동 상태]
 *   recordHeartbeat()            — 매 실행마다 상태 파일 갱신
 *   getStatus()                  — 현재 상태 조회
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// 모드별 상태 파일 분리 (DEV: invest-status-dev.json / OPS: invest-status.json)
const { getModeSuffix } = require('./mode');
const STATUS_FILE = `/tmp/invest-status${getModeSuffix()}.json`;

let _isShuttingDown = false;
let _runStart = null;

// ─── 상태 파일 ──────────────────────────────────────────────────────

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); }
  catch { return {}; }
}

function writeStatus(patch) {
  const current = readStatus();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2)); }
  catch (e) { console.warn(`⚠️ 상태 파일 쓰기 실패: ${e.message}`); }
  return next;
}

function recordHeartbeat({ status = 'running', error = null } = {}) {
  const prev = readStatus();
  writeStatus({
    status,
    pid:               process.pid,
    runCount:          (prev.runCount || 0) + (status === 'running' ? 1 : 0),
    lastRun:           status === 'running' ? new Date().toISOString() : prev.lastRun,
    lastError:         error ? String(error) : (status === 'idle' ? null : prev.lastError),
    consecutiveErrors: error
      ? (prev.consecutiveErrors || 0) + 1
      : (status === 'idle' ? 0 : prev.consecutiveErrors || 0),
    durationMs:        status === 'idle' && _runStart
      ? Date.now() - _runStart
      : prev.durationMs,
  });
  if (status === 'running') _runStart = Date.now();
}

function getStatus() {
  return readStatus();
}

// ─── 시작 2중: Node.js 프리플라이트 ────────────────────────────────

/**
 * 시작 2중 체크 (Node.js 레벨)
 * DB 연결·스키마·설정·모드 검증
 * @throws {Error} 검증 실패 시
 */
async function preflightSystemCheck() {
  const errors = [];
  console.log('  🔎 [2중] Node.js 프리플라이트 체크...');

  // 2-1. secrets + OPS 가드
  try {
    const { assertOpsReady } = require('./mode');
    assertOpsReady();
    console.log('      ✅ OPS 가드 통과');
  } catch (e) {
    errors.push(`OPS 가드: ${e.message.split('\n')[0]}`);
  }

  // 2-2. DuckDB 파일 존재
  const dbPath = path.join(__dirname, '..', 'db', 'invest.duckdb');
  if (!fs.existsSync(dbPath)) {
    errors.push(`DB 파일 없음: ${dbPath} → node scripts/setup-db.js 실행 필요`);
  } else {
    console.log('      ✅ DB 파일 존재');
  }

  // 2-3. DB 연결 + 4개 테이블 확인
  try {
    const db = require('./db');
    await db.initSchema(); // idempotent
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name`
    );
    const required = ['analysis', 'positions', 'signals', 'trades'];
    const missing  = required.filter(t => !tables.find(r => r.table_name === t));
    if (missing.length > 0) {
      errors.push(`테이블 누락: ${missing.join(', ')}`);
    } else {
      console.log(`      ✅ DB 스키마 (${tables.length}개 테이블)`);
    }
  } catch (e) {
    errors.push(`DB 연결 실패: ${e.message}`);
  }

  // 2-4. 포지션 DB 무결성 (amount < 0 방지)
  try {
    const db = require('./db');
    const badPositions = await db.query(`SELECT symbol FROM positions WHERE amount < 0`);
    if (badPositions.length > 0) {
      errors.push(`음수 포지션 감지: ${badPositions.map(p => p.symbol).join(', ')} — DB 점검 필요`);
    } else {
      console.log('      ✅ 포지션 무결성');
    }
  } catch {}

  // 2-5. 직전 실행 시간 확인 (비정상 단주기 방지: 3분 이내 재실행 차단)
  const prev = readStatus();
  if (prev.lastRun) {
    const elapsed = Date.now() - new Date(prev.lastRun).getTime();
    if (elapsed < 3 * 60 * 1000) {
      errors.push(
        `직전 실행 ${Math.round(elapsed / 1000)}초 전 — 최소 3분 간격 필요 (비정상 단주기 차단)`
      );
    } else {
      console.log(`      ✅ 직전 실행: ${Math.round(elapsed / 60000)}분 전`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[2중 체크 실패]\n${errors.map(e => `  ❌ ${e}`).join('\n')}`);
  }
  console.log('  ✅ [2중] Node.js 프리플라이트 통과');
}

// ─── 시작 3중: API 연결성 체크 ──────────────────────────────────────

/**
 * 시작 3중 체크 (API 레벨)
 * 바이낸스·텔레그램 실제 연결 테스트
 * @throws {Error} 연결 실패 시
 */
async function preflightConnCheck() {
  const errors = [];
  console.log('  🌐 [3중] API 연결성 체크...');

  // 3-1. 바이낸스 fetchTicker (실제 API 호출)
  try {
    const { fetchTicker } = require('./binance');
    const price = await fetchTicker('BTC/USDT');
    if (!price || price <= 0) throw new Error('가격 이상');
    console.log(`      ✅ 바이낸스 연결 ($${price.toLocaleString()})`);
  } catch (e) {
    errors.push(`바이낸스 연결 실패: ${e.message}`);
  }

  // 3-2. 텔레그램 테스트 발송
  try {
    const { tryTelegramSend } = require('./telegram');
    const ok = await tryTelegramSend('[3중 체크] 투자봇 OPS 시작 — 연결 확인');
    if (!ok) throw new Error('발송 실패');
    console.log('      ✅ 텔레그램 연결');
  } catch (e) {
    errors.push(`텔레그램 연결 실패: ${e.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`[3중 체크 실패]\n${errors.map(e => `  ❌ ${e}`).join('\n')}`);
  }
  console.log('  ✅ [3중] API 연결성 통과');
}

// ─── 종료 1중: Graceful flag ────────────────────────────────────────

function setShuttingDown() {
  _isShuttingDown = true;
}

function isShuttingDown() {
  return _isShuttingDown;
}

// ─── 종료 2중: DB 정리 ──────────────────────────────────────────────

/**
 * 종료 2중: pending 신호 롤백 + 포지션 스냅샷 저장
 */
async function shutdownDB() {
  console.log('\n  🗄️  [2중 종료] DB 정리...');
  try {
    const db = require('./db');

    // pending 신호 → failed 롤백 (orphan 방지)
    await db.run(
      `UPDATE signals SET status='failed' WHERE status='pending'`
    );

    // 포지션 스냅샷 저장 (파일)
    const positions = await db.getAllPositions();
    const snapshot = {
      savedAt:   new Date().toISOString(),
      pid:       process.pid,
      positions: positions.map(p => ({
        symbol:  p.symbol,
        amount:  p.amount,
        avgPrice: p.avg_price,
      })),
    };
    fs.writeFileSync('/tmp/invest-positions-snapshot.json', JSON.stringify(snapshot, null, 2));
    console.log(`      ✅ 포지션 스냅샷 저장 (${positions.length}개)`);

    // DB 연결 종료
    db.close();
    console.log('      ✅ DB 연결 종료');
  } catch (e) {
    console.error(`      ⚠️ DB 정리 실패: ${e.message}`);
  }
}

// ─── 종료 3중: Lock·파일·텔레그램 정리 ─────────────────────────────

/**
 * 종료 3중: 상태 기록 + 텔레그램 알림
 * @param {object} opts
 * @param {string} opts.reason  종료 사유
 * @param {boolean} opts.error  오류 종료 여부
 * @param {string[]} opts.locks 삭제할 lock 파일 목록
 */
async function shutdownCleanup({ reason = '정상 종료', error = false, locks = [] } = {}) {
  console.log('  🧹 [3중 종료] 정리...');

  // lock 파일 삭제
  for (const lk of locks) {
    try { fs.unlinkSync(lk); console.log(`      ✅ lock 삭제: ${lk}`); }
    catch {}
  }

  // 상태 기록
  writeStatus({
    status:    error ? 'error' : 'idle',
    lastError: error ? reason : null,
    pid:       null,
  });
  console.log('      ✅ 상태 파일 갱신');

  // 텔레그램 종료 알림
  try {
    const { tryTelegramSend } = require('./telegram');
    const emoji = error ? '❌' : '🏁';
    await tryTelegramSend(`${emoji} [투자봇 OPS] 종료\n사유: ${reason}`);
    console.log('      ✅ 텔레그램 종료 알림');
  } catch (e) {
    console.warn(`      ⚠️ 텔레그램 알림 실패: ${e.message}`);
  }

  console.log('  ✅ [3중 종료] 정리 완료');
}

// ─── 통합 graceful shutdown 핸들러 ─────────────────────────────────

/**
 * SIGTERM/SIGINT 핸들러 등록
 * @param {string[]} lockFiles  삭제할 lock 파일 목록
 */
function registerShutdownHandlers(lockFiles = []) {
  let _handled = false;

  async function onShutdown(signal) {
    if (_handled) return;
    _handled = true;
    setShuttingDown();

    console.log(`\n⚠️  [1중 종료] ${signal} 수신 — graceful shutdown 시작`);
    console.log('      ⏳ 진행 중 작업 완료 대기 (최대 15초)...');

    // 진행 중 작업 완료 대기 (최대 15초)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    await shutdownDB();
    await shutdownCleanup({
      reason: `${signal} 수신`,
      error:  signal === 'SIGTERM' ? false : true,
      locks:  lockFiles,
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
    await shutdownCleanup({ reason: err.message, error: true, locks: lockFiles });
    process.exit(1);
  });
}

module.exports = {
  // 상태
  readStatus, writeStatus, recordHeartbeat, getStatus,
  // 시작
  preflightSystemCheck, preflightConnCheck,
  // 종료
  setShuttingDown, isShuttingDown,
  shutdownDB, shutdownCleanup,
  registerShutdownHandlers,
};
