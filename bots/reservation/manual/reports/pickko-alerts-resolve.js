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
const { getDb }     = require('../../lib/db');

const ARGS  = parseArgs(process.argv);
const phone = ARGS['phone'] || null;
const date  = ARGS['date']  || null;
const start = ARGS['start'] || null;

const db = getDb();

let result;

if (phone && date && start) {
  // 특정 예약 알림만 해결
  result = db.prepare(`
    UPDATE alerts
    SET resolved = 1, resolved_at = datetime('now')
    WHERE resolved = 0 AND type = 'error'
      AND phone = ? AND date = ? AND start_time = ?
  `).run(phone, date, start);
} else {
  // 전체 미해결 오류 알림 해결
  result = db.prepare(`
    UPDATE alerts
    SET resolved = 1, resolved_at = datetime('now')
    WHERE resolved = 0 AND type = 'error'
  `).run();
}

const n = result.changes;

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
