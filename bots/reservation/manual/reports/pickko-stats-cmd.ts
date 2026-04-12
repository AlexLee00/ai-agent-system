#!/usr/bin/env node
// @ts-nocheck

/**
 * pickko-stats-cmd.js — 매출 통계 조회 CLI
 */

const { getDailySummary, getDailySummariesInRange, getRoomRevenueSummary } = require('../../lib/db');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');

const ARGS = parseArgs(process.argv);

function ok(message) {
  outputResult({ success: true, message });
  process.exit(0);
}

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function toDateStr(d) {
  return d.toLocaleDateString('en-CA');
}

function resolveDate(arg) {
  const now = nowKST();
  if (!arg || arg === 'today') return toDateStr(now);
  if (arg === 'yesterday') {
    now.setDate(now.getDate() - 1);
    return toDateStr(now);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return null;
}

function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${days[d.getDay()]})`;
}

function formatMonth(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

function won(amount) {
  return `${Number(amount || 0).toLocaleString('ko-KR')}원`;
}

function buildDayMessage(row, label) {
  if (!row) return `${label}\n\n📭 매출 데이터 없음 (집계 전이거나 해당 날짜 데이터 미존재)`;

  const lines = [`📅 ${label} 매출`, ''];
  const roomAmounts = row.roomAmounts || {};
  const generalRevenue = row.generalRevenue || 0;
  const grandTotal = (row.total_amount || 0) + generalRevenue;

  if (generalRevenue > 0) lines.push(`  일반이용: ${won(generalRevenue)}`);
  for (const [room, amount] of Object.entries(roomAmounts).sort()) {
    if (amount > 0) lines.push(`  ${room}룸: ${won(amount)}`);
  }

  lines.push(`  합계: ${won(grandTotal)}`);
  lines.push('');
  lines.push(row.confirmed ? '  ✅ 확정됨' : '  ⏳ 미확정');

  return lines.join('\n');
}

function buildPeriodMessage(rows, label) {
  if (rows.length === 0) return `${label}\n\n📭 집계된 매출 데이터 없음`;

  const totals = {};
  let totalAmount = 0;
  let generalRevenue = 0;
  let confirmedCount = 0;
  let unconfirmedCount = 0;

  for (const row of rows) {
    totalAmount += row.total_amount || 0;
    generalRevenue += row.generalRevenue || 0;
    for (const [room, amount] of Object.entries(row.roomAmounts || {})) {
      totals[room] = (totals[room] || 0) + amount;
    }
    if (row.confirmed) confirmedCount++;
    else unconfirmedCount++;
  }

  const lines = [`📊 ${label}`, `   (${rows.length}일 집계)`, ''];

  if (generalRevenue > 0) lines.push(`  일반이용: ${won(generalRevenue)}`);
  for (const [room, amount] of Object.entries(totals).sort()) {
    if (amount > 0) lines.push(`  ${room}룸: ${won(amount)}`);
  }
  lines.push(`  합계: ${won(totalAmount + generalRevenue)}`);
  lines.push('');

  const statusParts = [];
  if (confirmedCount > 0) statusParts.push(`✅ 확정 ${confirmedCount}일`);
  if (unconfirmedCount > 0) statusParts.push(`⏳ 미확정 ${unconfirmedCount}일`);
  if (statusParts.length > 0) lines.push(`  ${statusParts.join(' | ')}`);

  return lines.join('\n');
}

function buildCumulativeMessage(rows) {
  if (rows.length === 0) return '📊 누적 확정 매출\n\n📭 확정된 매출 데이터 없음';

  let total = 0;
  const lines = ['📊 누적 확정 매출 (전체 기간)', ''];
  for (const r of rows) {
    const label = r.room === '일반이용' ? '일반이용' : `${r.room}룸`;
    const amount = r.total_amount;
    lines.push(`  ${label}: ${won(amount)} (${r.days}일)`);
    total += amount;
  }
  lines.push(`  합계: ${won(total)}`);
  return lines.join('\n');
}

const isCumulative = process.argv.includes('--cumulative');

if (isCumulative) {
  try {
    const rows = getRoomRevenueSummary();
    ok(buildCumulativeMessage(rows));
  } catch (e) {
    fail(`누적 매출 조회 실패: ${e.message}`);
  }
} else if (ARGS.month) {
  if (!/^\d{4}-\d{2}$/.test(ARGS.month)) {
    fail(`월 형식 오류: ${ARGS.month} (예: 2026-02)`);
  }
  const [y, m] = ARGS.month.split('-').map(Number);
  const startDate = `${ARGS.month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${ARGS.month}-${String(lastDay).padStart(2, '0')}`;
  try {
    const rows = getDailySummariesInRange(startDate, endDate);
    ok(buildPeriodMessage(rows, `${formatMonth(startDate)} 매출`));
  } catch (e) {
    fail(`월 매출 조회 실패: ${e.message}`);
  }
} else if (ARGS.period) {
  const now = nowKST();
  let startDate;
  let label;

  if (ARGS.period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    startDate = toDateStr(monday);
    label = '이번 주 매출';
  } else if (ARGS.period === 'month') {
    startDate = toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    label = `${now.getMonth() + 1}월 매출`;
  } else {
    fail(`--period 오류: ${ARGS.period} (허용: week|month)`);
  }

  const endDate = toDateStr(now);
  try {
    const rows = getDailySummariesInRange(startDate, endDate);
    ok(buildPeriodMessage(rows, label));
  } catch (e) {
    fail(`기간 매출 조회 실패: ${e.message}`);
  }
} else if (ARGS.date !== undefined || Object.keys(ARGS).filter((k) => k !== '_').length === 0) {
  const dateArg = ARGS.date;
  const resolved = resolveDate(dateArg);
  if (!resolved) fail(`날짜 형식 오류: ${dateArg} (예: today, yesterday, 2026-02-26)`);

  try {
    const row = getDailySummary(resolved);
    ok(buildDayMessage(row, formatDate(resolved)));
  } catch (e) {
    fail(`매출 조회 실패: ${e.message}`);
  }
} else {
  fail('옵션 오류.\n  --date=today|yesterday|YYYY-MM-DD\n  --period=week|month\n  --month=YYYY-MM\n  --cumulative');
}
