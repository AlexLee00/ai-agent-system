#!/usr/bin/env node

/**
 * pickko-alerts-resolve.js — 미해결 오류 알림 수동 해결 처리 CLI
 *
 * 사용법:
 *   node manual/reports/pickko-alerts-resolve.js --list       # 미해결 오류 알림 목록 조회
 *   node manual/reports/pickko-alerts-resolve.js              # 전체 미해결 오류 알림 해결
 *   node manual/reports/pickko-alerts-resolve.js --phone=0101234567 --date=2026-03-06 --start=19:00
 *
 * 출력 (stdout JSON):
 *   { success: true, resolved: N, message: "..." }
 */

const { parseArgs } = require('../../lib/args');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { resolveOpenKioskBlockFollowups } = require('../../lib/db');

const ARGS  = parseArgs(process.argv);
const list  = !!ARGS['list'];
const phone = ARGS['phone'] || null;
const date  = ARGS['date']  || null;
const start = ARGS['start'] || null;

let result;

(async () => {
  if (list) {
    const rows = await pgPool.query('reservation', `
      SELECT id, phone, date, start_time, title, message, timestamp
      FROM alerts
      WHERE resolved = 0 AND type = 'error'
      ORDER BY timestamp DESC
      LIMIT 20
    `);

    console.log(JSON.stringify({
      success: true,
      listed: rows.length,
      items: rows,
      message: rows.length > 0
        ? `미해결 오류 알림 ${rows.length}건 조회 완료`
        : '미해결 오류 알림 없음',
    }));
    return;
  }

  let followups = [];
  if (phone && date && start) {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
        AND phone = $1 AND date = $2 AND start_time = $3
    `, [phone, date, start]);
    followups = await resolveOpenKioskBlockFollowups({ phone, date, start });
  } else {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
    `, []);
    followups = await resolveOpenKioskBlockFollowups({});
  }

  const n = Number(result?.rowCount || 0);
  const followupCount = Number(followups?.length || 0);

  if (n === 0 && followupCount === 0) {
    console.log(JSON.stringify({
      success: true, resolved: 0,
      message: '미해결 오류 알림 없음 (이미 모두 해결됨)',
    }));
  } else {
    console.log(JSON.stringify({
      success: true,
      resolved: n,
      kioskFollowups: followupCount,
      message: followupCount > 0
        ? `✅ 미해결 오류 알림 ${n}건 해결 처리 완료 / 네이버 차단 follow-up ${followupCount}건 수동 완료 반영`
        : `✅ 미해결 오류 알림 ${n}건 해결 처리 완료`,
    }));
  }
})().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
