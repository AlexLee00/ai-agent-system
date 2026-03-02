#!/usr/bin/env node

/**
 * pickko-alerts-query.js — 최근 알림 조회 CLI
 *
 * 사용법:
 *   node src/pickko-alerts-query.js              # 최근 24시간 전체 알림
 *   node src/pickko-alerts-query.js --hours=48   # 최근 48시간
 *   node src/pickko-alerts-query.js --type=error # 에러(실패)만
 *   node src/pickko-alerts-query.js --unresolved # 미해결만
 *
 * 출력 (stdout JSON):
 *   { success: true, count: N, message: "포맷된 결과" }
 */

const { parseArgs } = require('../../lib/args');
const { getDb } = require('../../lib/db');

const ARGS   = parseArgs(process.argv);
const hours  = parseInt(ARGS['hours'] || '24', 10);
const typeF  = ARGS['type']       || null;   // 'error' | 'new' | 'completed' | null
const unresO = ARGS['unresolved'] === true;  // --unresolved 플래그

const db = getDb();

// ── 쿼리 ──
let sql = `SELECT id, timestamp, type, title, message, resolved, resolved_at, phone, date, start_time
           FROM alerts
           WHERE timestamp > datetime('now', '-${hours} hours')`;
if (typeF) sql += ` AND type = '${typeF.replace(/'/g, "''")}'`;
if (unresO) sql += ` AND resolved = 0`;
sql += ` ORDER BY timestamp DESC LIMIT 30`;

const rows = db.prepare(sql).all();

// ── 포맷 ──
function fmt(r) {
  const ts  = new Date(r.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const icon = r.type === 'error'     ? '❌'
             : r.type === 'completed' ? '✅'
             : r.type === 'new'       ? '🆕'
             : r.type === 'cancelled' ? '🚫'
             : 'ℹ️';
  const res = r.resolved ? '' : ' 🔴미해결';
  const who = r.phone ? ` (${r.phone})` : '';
  const when = r.date  ? ` ${r.date}${r.start_time ? ' ' + r.start_time : ''}` : '';
  return `${icon} [${ts}]${res} ${r.title}${who}${when}`;
}

if (rows.length === 0) {
  const scope = typeF ? `${typeF} 타입` : '전체';
  const filter = unresO ? ' (미해결만)' : '';
  console.log(JSON.stringify({
    success: true, count: 0,
    message: `최근 ${hours}시간 ${scope} 알림${filter} 없음`,
  }));
  process.exit(0);
}

const lines  = rows.map(fmt);
const errCnt = rows.filter(r => r.type === 'error').length;
const unresCnt = rows.filter(r => !r.resolved).length;

let header = `📋 최근 ${hours}시간 알림 (${rows.length}건)`;
if (errCnt > 0) header += ` — 실패 ${errCnt}건`;
if (unresCnt > 0) header += `, 미해결 ${unresCnt}건`;

const message = [header, '', ...lines].join('\n');

console.log(JSON.stringify({ success: true, count: rows.length, message }));
