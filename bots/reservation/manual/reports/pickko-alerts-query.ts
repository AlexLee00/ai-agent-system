#!/usr/bin/env node

/**
 * pickko-alerts-query.js — 최근 알림 조회 CLI
 */

const { parseArgs } = require('../../lib/args');
const pgPool = require('../../../../packages/core/lib/pg-pool');

const ARGS = parseArgs(process.argv);
const hours = parseInt(ARGS.hours || '24', 10);
const typeF = ARGS.type || null;
const unresO = ARGS.unresolved === true;
const phoneF = ARGS.phone || null;
const dateF = ARGS.date || null;
const startF = ARGS.start || null;

type AlertRow = {
  id: string;
  timestamp: string | Date;
  type: string;
  title: string;
  message: string | null;
  resolved: number | boolean;
  resolved_at: string | Date | null;
  phone: string | null;
  date: string | null;
  start_time: string | null;
};

async function queryAlerts(): Promise<AlertRow[]> {
  const clauses = [`timestamp::timestamptz > NOW() - ($1::int * INTERVAL '1 hour')`];
  const params: Array<number | string> = [hours];

  if (typeF) {
    params.push(typeF);
    clauses.push(`type = $${params.length}`);
  }
  if (unresO) {
    clauses.push('resolved = 0');
  }
  if (phoneF) {
    params.push(phoneF);
    clauses.push(`phone = $${params.length}`);
  }
  if (dateF) {
    params.push(dateF);
    clauses.push(`date = $${params.length}`);
  }
  if (startF) {
    params.push(startF);
    clauses.push(`start_time = $${params.length}`);
  }

  return pgPool.query('reservation', `
    SELECT id, timestamp, type, title, message, resolved, resolved_at, phone, date, start_time
      FROM alerts
     WHERE ${clauses.join(' AND ')}
     ORDER BY timestamp DESC
     LIMIT 30
  `, params);
}

function fmt(r: AlertRow) {
  const ts = new Date(r.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const icon = r.type === 'error'
    ? '❌'
    : r.type === 'completed'
      ? '✅'
      : r.type === 'new'
        ? '🆕'
        : r.type === 'cancelled'
          ? '🚫'
          : 'ℹ️';
  const res = r.resolved ? '' : ' 🔴미해결';
  const who = r.phone ? ` (${r.phone})` : '';
  const when = r.date ? ` ${r.date}${r.start_time ? ` ${r.start_time}` : ''}` : '';
  return `${icon} [${ts}]${res} ${r.title}${who}${when}`;
}

(async () => {
  const rows = await queryAlerts();

  if (rows.length === 0) {
    const scope = typeF ? `${typeF} 타입` : '전체';
    const filters = [];
    if (unresO) filters.push('미해결만');
    if (phoneF) filters.push(`phone=${phoneF}`);
    if (dateF) filters.push(`date=${dateF}`);
    if (startF) filters.push(`start=${startF}`);
    const filterText = filters.length ? ` (${filters.join(', ')})` : '';
    console.log(JSON.stringify({
      success: true,
      count: 0,
      message: `최근 ${hours}시간 ${scope} 알림${filterText} 없음`,
    }));
    return;
  }

  const lines = rows.map(fmt);
  const errCnt = rows.filter((row) => row.type === 'error').length;
  const unresCnt = rows.filter((row) => !Number(row.resolved)).length;

  let header = `📋 최근 ${hours}시간 알림 (${rows.length}건)`;
  if (errCnt > 0) header += ` — 실패 ${errCnt}건`;
  if (unresCnt > 0) header += `, 미해결 ${unresCnt}건`;

  const message = [header, '', ...lines].join('\n');
  console.log(JSON.stringify({ success: true, count: rows.length, message }));
})().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
