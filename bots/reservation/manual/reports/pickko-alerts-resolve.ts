#!/usr/bin/env node
// @ts-nocheck

/**
 * pickko-alerts-resolve.js — 미해결 오류 알림 수동 해결 처리 CLI
 */

const { parseArgs } = require('../../lib/args');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { resolveOpenKioskBlockFollowups } = require('../../lib/db');

const ARGS = parseArgs(process.argv);
const list = !!ARGS.list;
const recent = !!ARGS.recent;
const phone = ARGS.phone || null;
const date = ARGS.date || null;
const start = ARGS.start || null;

let result;

async function listUnresolvedAlerts() {
  return pgPool.query('reservation', `
    SELECT id, phone, date, start_time, title, message, timestamp
    FROM alerts
    WHERE resolved = 0 AND type = 'error'
    ORDER BY timestamp DESC
    LIMIT 20
  `);
}

async function listRecentAlertCandidates() {
  return pgPool.query('reservation', `
    SELECT
      phone,
      date,
      start_time,
      MAX(timestamp) AS latest_timestamp,
      COUNT(*) AS alert_count
    FROM alerts
    WHERE resolved = 0
      AND type = 'error'
      AND date >= to_char(current_date - interval '7 days', 'YYYY-MM-DD')
    GROUP BY phone, date, start_time
    ORDER BY MAX(timestamp) DESC
    LIMIT 5
  `);
}

(async () => {
  if (list) {
    const rows = await listUnresolvedAlerts();

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

  if (recent) {
    const candidates = await listRecentAlertCandidates();

    if (candidates.length === 0) {
      console.log(JSON.stringify({
        success: true,
        resolved: 0,
        message: '최근 미해결 오류 알림 없음',
      }));
      return;
    }

    if (candidates.length > 1) {
      console.log(JSON.stringify({
        success: false,
        requiresDisambiguation: true,
        message: '최근 미해결 후보가 여러 건이라 자동 해제할 수 없습니다. phone/date/start를 함께 지정해주세요.',
        candidates,
      }));
      return;
    }

    const candidate = candidates[0];
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
        AND phone = $1 AND date = $2 AND start_time = $3
    `, [candidate.phone, candidate.date, candidate.start_time]);

    const followups = await resolveOpenKioskBlockFollowups({
      phone: candidate.phone,
      date: candidate.date,
      start: candidate.start_time,
    });

    console.log(JSON.stringify({
      success: true,
      recent: true,
      resolved: Number(result?.rowCount || 0),
      kioskFollowups: Number(followups?.length || 0),
      target: {
        phone: candidate.phone,
        date: candidate.date,
        start: candidate.start_time,
      },
      message: `최근 미해결 오류 알림 자동 해결 완료 (${candidate.phone} ${candidate.date} ${candidate.start_time})`,
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
      success: true,
      resolved: 0,
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
