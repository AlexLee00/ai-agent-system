// @ts-nocheck
'use strict';

/**
 * checks/bot-behavior.js — 봇 비정상 행동 감지
 *
 * 감지 항목:
 *   1. 독터 복구 루프 — 동일 task_type 10분 내 5건 이상 실패
 *   2. 루나팀 급속 신호 — 5분 내 거래 신호 5건 이상
 *   3. 최근 복구 시도율 — 1시간 내 독터 실패율 80% 이상 (심각 판단)
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

// ─── 독터 복구 루프 감지 ─────────────────────────────────────────────

async function checkDoctorLoop() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT task_type, COUNT(*) AS cnt
      FROM doctor_log
      WHERE created_at > NOW() - INTERVAL '10 minutes'
        AND success = false
      GROUP BY task_type
      HAVING COUNT(*) >= 5
    `);

    if (rows.length > 0) {
      return rows.map(r => ({
        label:  `독터 루프: ${r.task_type}`,
        status: 'error',
        detail: `10분 내 복구 실패 ${r.cnt}건 — 루프 의심`,
      }));
    }
    return [{ label: '독터 복구 루프', status: 'ok', detail: '이상 없음' }];
  } catch (e) {
    return [{ label: '독터 복구 루프', status: 'warn', detail: `조회 실패: ${e.message}` }];
  }
}

// ─── 독터 최근 실패율 감지 ───────────────────────────────────────────

async function checkDoctorFailureRate() {
  try {
    const row = await pgPool.get('reservation', `
      SELECT
        COUNT(*) FILTER (WHERE success = true)  AS ok_cnt,
        COUNT(*) FILTER (WHERE success = false) AS fail_cnt,
        COUNT(*) AS total
      FROM doctor_log
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `);

    const total   = Number(row?.total   || 0);
    const failCnt = Number(row?.fail_cnt || 0);

    if (total < 3) {
      return [{ label: '독터 실패율 (1h)', status: 'ok', detail: `시도 ${total}건 (정상)` }];
    }

    const failRate = failCnt / total;
    if (failRate >= 0.8) {
      return [{ label: '독터 실패율 (1h)', status: 'error', detail: `실패율 ${Math.round(failRate * 100)}% (${failCnt}/${total}) — 심각` }];
    } else if (failRate >= 0.5) {
      return [{ label: '독터 실패율 (1h)', status: 'warn', detail: `실패율 ${Math.round(failRate * 100)}% (${failCnt}/${total})` }];
    }
    return [{ label: '독터 실패율 (1h)', status: 'ok', detail: `실패율 ${Math.round(failRate * 100)}% (${failCnt}/${total})` }];
  } catch (e) {
    return [{ label: '독터 실패율 (1h)', status: 'warn', detail: `조회 실패: ${e.message}` }];
  }
}

// ─── 루나팀 급속 신호 감지 ──────────────────────────────────────────

async function checkLunaRapidSignals() {
  try {
    const row = await pgPool.get('investment', `
      SELECT COUNT(*) AS cnt
      FROM trade_signals
      WHERE created_at > NOW() - INTERVAL '5 minutes'
    `);
    const cnt = Number(row?.cnt || 0);

    if (cnt >= 10) {
      return [{ label: '루나팀 급속 신호', status: 'error', detail: `5분 내 거래 신호 ${cnt}건 — 비정상 급속 매매 의심` }];
    } else if (cnt >= 5) {
      return [{ label: '루나팀 급속 신호', status: 'warn', detail: `5분 내 거래 신호 ${cnt}건 — 주의` }];
    }
    return [{ label: '루나팀 거래 신호', status: 'ok', detail: `최근 5분 ${cnt}건 (정상)` }];
  } catch {
    // trade_signals 테이블이 없거나 접근 불가 시 스킵
    return [{ label: '루나팀 급속 신호', status: 'ok', detail: '조회 스킵' }];
  }
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function run() {
  const [loopItems, failRateItems, lunaItems] = await Promise.all([
    checkDoctorLoop(),
    checkDoctorFailureRate(),
    checkLunaRapidSignals(),
  ]);

  const items     = [...loopItems, ...failRateItems, ...lunaItems];
  const hasError  = items.some(i => i.status === 'error');
  const hasWarn   = items.some(i => i.status === 'warn');

  return {
    name:   '봇 비정상 행동',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
