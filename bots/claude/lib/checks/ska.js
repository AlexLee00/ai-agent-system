'use strict';

/**
 * checks/ska.js — 스카팀 에이전트 상태 체크 (덱스터 전용)
 *
 * PostgreSQL reservation 스키마 직접 조회:
 *   1. DB 연결 확인 (pgPool.ping)
 *   2. agent_state staleness (> 10분 warn, > 30분 error)
 *   3. pickko_lock 데드락 감지 (TTL 초과 락 잔존 → warn)
 *   4. pending_blocks 적체 (> 5건 → warn)
 *   5. naver-monitor(앤디) 마지막 성공 시각 (> 60분 → warn)
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

// ── 체크 1: DB 연결 확인 ──────────────────────────────────────────
async function checkDbExists(items) {
  try {
    const ok = await pgPool.ping(SCHEMA);
    if (ok) {
      items.push({ label: '스카팀 PostgreSQL', status: 'ok', detail: `reservation 스키마 연결 정상` });
      return true;
    } else {
      items.push({ label: '스카팀 PostgreSQL', status: 'error', detail: 'ping 실패' });
      return false;
    }
  } catch (e) {
    items.push({ label: '스카팀 PostgreSQL', status: 'error', detail: `연결 실패: ${e.message}` });
    return false;
  }
}

// ── 체크 2: agent_state staleness ───────────────────────────────
async function checkAgentStaleness(items) {
  let rows;
  try {
    rows = await pgPool.query(SCHEMA,
      'SELECT agent, status, updated_at FROM agent_state');
  } catch (e) {
    items.push({ label: '에이전트 상태 테이블', status: 'warn', detail: `조회 실패: ${e.message}` });
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
async function checkPickkoLock(items) {
  let lock;
  try {
    lock = await pgPool.get(SCHEMA, 'SELECT * FROM pickko_lock WHERE id = 1');
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
async function checkPendingBlocks(items) {
  let count;
  try {
    const row = await pgPool.get(SCHEMA,
      "SELECT COUNT(*) AS cnt FROM pending_blocks WHERE status = 'pending'");
    count = parseInt(row?.cnt ?? 0, 10);
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
async function checkAndyLastSuccess(items) {
  let row;
  try {
    row = await pgPool.get(SCHEMA,
      "SELECT last_success_at FROM agent_state WHERE agent = 'andy'");
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

// ── 체크 6: 완료 예약 취소 상태 감지 ───────────────────────────────
// cancelled_keys에 등록된 항목 중 reservations.status='completed'인 건을 두 케이스로 분류:
//   A) 미래 예약 + completed → 네이버 취소됐으나 Picco 취소 실패 (warn, 수동 처리 필요)
//   B) 과거 예약 + completed → 이용 완료 후 정상 소멸인데 취소감지 오발동 (error)
async function checkFalseCancellation(items) {
  let rows;
  try {
    rows = await pgPool.query(SCHEMA, `
      SELECT ck.cancel_key, r.id, r.date, r.start_time, r.end_time, r.room, r.phone, ck.cancelled_at
      FROM cancelled_keys ck
      JOIN reservations r
        ON ck.cancel_key = 'cancelid|' || r.id::text
      WHERE r.status = 'completed'
        AND ck.cancelled_at::timestamp > NOW() - INTERVAL '7 days'
      LIMIT 10
    `);
  } catch (e) {
    items.push({ label: '완료 예약 취소 감지', status: 'warn', detail: `조회 실패: ${e.message}` });
    return;
  }

  if (rows && rows.length > 0) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    for (const row of rows) {
      if (row.date > today) {
        // 케이스 A: 미래 예약 → 네이버 취소됐으나 Picco 취소 실패 (warn)
        items.push({
          label:  'Picco 취소 실패 (수동 처리 필요)',
          status: 'warn',
          detail: `${row.phone} ${row.date} ${row.start_time}~${row.end_time} ${row.room} — 네이버 취소됐으나 Picco 미반영`,
        });
      } else {
        // 케이스 B: 과거/당일 예약 → 이용 완료 후 취소감지 오발동 (error)
        items.push({
          label:  '완료 예약 허위 취소',
          status: 'error',
          detail: `id=${row.id} ${row.date} ${row.start_time}~${row.end_time} ${row.room} — 이용 완료 예약이 취소감지에 걸림 (오발동)`,
        });
      }
    }
  } else {
    items.push({ label: '완료 예약 취소 감지', status: 'ok', detail: '이상 없음' });
  }
}

// ─── 메인 run ────────────────────────────────────────────────────

async function run() {
  const items = [];

  const dbOk = await checkDbExists(items);
  if (!dbOk) {
    // DB 연결 실패 시 나머지 체크 생략
    return { name: '스카팀 에이전트', status: 'error', items };
  }

  await checkAgentStaleness(items);
  await checkPickkoLock(items);
  await checkPendingBlocks(items);
  await checkAndyLastSuccess(items);
  await checkFalseCancellation(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '스카팀 에이전트',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
