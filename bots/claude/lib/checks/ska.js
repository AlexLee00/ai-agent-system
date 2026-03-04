'use strict';

/**
 * checks/ska.js — 스카팀 에이전트 상태 체크 (덱스터 전용)
 *
 * state.db를 read-only로 열어 다음을 확인:
 *   1. DB 파일 존재 여부
 *   2. agent_state staleness (> 10분 warn, > 30분 error)
 *   3. pickko_lock 데드락 감지 (TTL 초과 락 잔존 → warn)
 *   4. pending_blocks 적체 (> 5건 → warn)
 *   5. naver-monitor(앤디) 마지막 성공 시각 (> 60분 → warn)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'state.db');

// 덱스터는 bots/reservation/node_modules 아래의 better-sqlite3 사용
const RESERVATION_BOT_PATH = path.join(
  __dirname, '..', '..', '..', '..', 'reservation'
);

function getBetterSqlitePath() {
  const local = path.join(RESERVATION_BOT_PATH, 'node_modules', 'better-sqlite3');
  if (fs.existsSync(local)) return local;
  // 루트 node_modules 폴백
  const root = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'better-sqlite3');
  return root;
}

/**
 * state.db 스크립트를 임시 파일로 실행 (read-only)
 * @param {string} script
 * @returns {any} JSON 파싱 결과
 */
function runDbScript(script) {
  const tmp = path.join(os.tmpdir(), `dexter-ska-${Date.now()}.js`);
  const bsPath = getBetterSqlitePath();
  const wrapped = `
    'use strict';
    const Database = require(${JSON.stringify(bsPath)});
    const db = new Database(${JSON.stringify(DB_PATH)}, { readonly: true });
    try {
      ${script}
    } finally {
      db.close();
    }
  `;
  try {
    fs.writeFileSync(tmp, wrapped);
    const out = execSync(`"${process.execPath}" "${tmp}"`, { timeout: 10000, encoding: 'utf8' });
    return JSON.parse(out.trim());
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── 체크 1: DB 파일 존재 ──────────────────────────────────────────
function checkDbExists(items) {
  if (!fs.existsSync(DB_PATH)) {
    items.push({ label: '스카팀 state.db', status: 'error', detail: `DB 파일 없음: ${DB_PATH}` });
    return false;
  }
  const stat = fs.statSync(DB_PATH);
  const kb = Math.round(stat.size / 1024);
  items.push({ label: '스카팀 state.db', status: 'ok', detail: `${kb}KB` });
  return true;
}

// ── 체크 2: agent_state staleness ───────────────────────────────
function checkAgentStaleness(items) {
  let rows;
  try {
    rows = runDbScript(`
      const rows = db.prepare(
        "SELECT agent, status, updated_at FROM agent_state"
      ).all();
      process.stdout.write(JSON.stringify(rows));
    `);
  } catch (e) {
    // agent_state 테이블이 아직 없을 수 있음 (마이그레이션 전)
    items.push({ label: '에이전트 상태 테이블', status: 'warn', detail: `조회 실패 (마이그레이션 필요?): ${e.message}` });
    return;
  }

  if (!rows || rows.length === 0) {
    items.push({ label: '에이전트 상태', status: 'ok', detail: '데이터 없음 (아직 실행 안됨)' });
    return;
  }

  const now = Date.now();
  for (const row of rows) {
    const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const elapsedMs = now - updatedAt;
    const elapsedMin = Math.floor(elapsedMs / 60000);

    if (elapsedMs > 30 * 60 * 1000) {
      items.push({
        label: `에이전트 ${row.agent}`,
        status: 'error',
        detail: `${elapsedMin}분 전 마지막 업데이트 (상태: ${row.status})`,
      });
    } else if (elapsedMs > 10 * 60 * 1000) {
      items.push({
        label: `에이전트 ${row.agent}`,
        status: 'warn',
        detail: `${elapsedMin}분 전 마지막 업데이트 (상태: ${row.status})`,
      });
    } else {
      items.push({
        label: `에이전트 ${row.agent}`,
        status: 'ok',
        detail: `${elapsedMin}분 전 업데이트 (상태: ${row.status})`,
      });
    }
  }
}

// ── 체크 3: pickko_lock 데드락 감지 ─────────────────────────────
function checkPickkoLock(items) {
  let lock;
  try {
    lock = runDbScript(`
      const row = db.prepare("SELECT * FROM pickko_lock WHERE id = 1").get();
      process.stdout.write(JSON.stringify(row || null));
    `);
  } catch (e) {
    items.push({ label: '픽코 락 상태', status: 'warn', detail: `조회 실패: ${e.message}` });
    return;
  }

  if (!lock || !lock.locked_by) {
    items.push({ label: '픽코 락', status: 'ok', detail: '락 없음 (정상)' });
    return;
  }

  const expiresAt = lock.expires_at ? new Date(lock.expires_at).getTime() : 0;
  const now = Date.now();

  if (expiresAt > 0 && now > expiresAt) {
    const overMin = Math.floor((now - expiresAt) / 60000);
    items.push({
      label: '픽코 락',
      status: 'warn',
      detail: `데드락 의심 — ${lock.locked_by}가 획득, TTL ${overMin}분 초과 (만료: ${lock.expires_at})`,
    });
  } else {
    const remainMs = expiresAt - now;
    const remainSec = Math.floor(remainMs / 1000);
    items.push({
      label: '픽코 락',
      status: 'ok',
      detail: `${lock.locked_by} 사용 중 (${remainSec}초 후 만료)`,
    });
  }
}

// ── 체크 4: pending_blocks 적체 ─────────────────────────────────
function checkPendingBlocks(items) {
  let count;
  try {
    count = runDbScript(`
      const row = db.prepare(
        "SELECT COUNT(*) as cnt FROM pending_blocks WHERE status = 'pending'"
      ).get();
      process.stdout.write(JSON.stringify(row.cnt));
    `);
  } catch (e) {
    items.push({ label: '블록 요청 큐', status: 'warn', detail: `조회 실패: ${e.message}` });
    return;
  }

  if (count > 5) {
    items.push({ label: '블록 요청 큐', status: 'warn', detail: `미처리 ${count}건 적체` });
  } else {
    items.push({ label: '블록 요청 큐', status: 'ok', detail: `미처리 ${count}건` });
  }
}

// ── 체크 5: 앤디(naver-monitor) 마지막 성공 시각 ────────────────
function checkAndyLastSuccess(items) {
  let row;
  try {
    row = runDbScript(`
      const r = db.prepare(
        "SELECT last_success_at FROM agent_state WHERE agent = 'andy'"
      ).get();
      process.stdout.write(JSON.stringify(r || null));
    `);
  } catch (e) {
    items.push({ label: '앤디 마지막 성공', status: 'warn', detail: `조회 실패: ${e.message}` });
    return;
  }

  if (!row || !row.last_success_at) {
    items.push({ label: '앤디 마지막 성공', status: 'ok', detail: '기록 없음 (아직 실행 안됨)' });
    return;
  }

  const lastSuccess = new Date(row.last_success_at).getTime();
  const elapsedMs = Date.now() - lastSuccess;
  const elapsedMin = Math.floor(elapsedMs / 60000);

  if (elapsedMs > 60 * 60 * 1000) {
    items.push({
      label: '앤디 마지막 성공',
      status: 'warn',
      detail: `${elapsedMin}분 전 (60분 초과 — 모니터 중단 의심)`,
    });
  } else {
    items.push({
      label: '앤디 마지막 성공',
      status: 'ok',
      detail: `${elapsedMin}분 전`,
    });
  }
}

// ─── 메인 run ────────────────────────────────────────────────────

async function run() {
  const items = [];

  const dbOk = checkDbExists(items);
  if (!dbOk) {
    // DB 없으면 나머지 체크 생략
    return { name: '스카팀 에이전트', status: 'error', items };
  }

  checkAgentStaleness(items);
  checkPickkoLock(items);
  checkPendingBlocks(items);
  checkAndyLastSuccess(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '스카팀 에이전트',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
