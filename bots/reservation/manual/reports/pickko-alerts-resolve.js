#!/usr/bin/env node

/**
 * pickko-alerts-resolve.js — 미해결 오류 알림 수동 해결 처리 CLI
 *
 * 사용법:
 *   node manual/reports/pickko-alerts-resolve.js              # 전체 미해결 오류 알림 해결
 *   node manual/reports/pickko-alerts-resolve.js --phone=0101234567 --date=2026-03-06 --start=19:00
 *
 * 출력 (stdout JSON):
 *   { success: true, resolved: N, message: "..." }
 */

const { parseArgs } = require('../../lib/args');
const pgPool = require('../../../../packages/core/lib/pg-pool');

const ARGS  = parseArgs(process.argv);
const phone = ARGS['phone'] || null;
const date  = ARGS['date']  || null;
const start = ARGS['start'] || null;

let result;

(async () => {
  if (phone && date && start) {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
        AND phone = $1 AND date = $2 AND start_time = $3
    `, [phone, date, start]);
  } else {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
    `, []);
  }

  const n = Number(result?.rowCount || 0);

  if (n === 0) {
    console.log(JSON.stringify({
      success: true, resolved: 0,
      message: '미해결 오류 알림 없음 (이미 모두 해결됨)',
    }));
  } else {
    console.log(JSON.stringify({
      success: true, resolved: n,
      message: `✅ 미해결 오류 알림 ${n}건 해결 처리 완료`,
    }));
  }
})().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
