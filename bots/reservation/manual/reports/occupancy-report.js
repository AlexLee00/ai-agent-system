#!/usr/bin/env node

/**
 * occupancy-report.js — 룸별·시간대별 가동률 리포트
 *
 * 사용법:
 *   node src/occupancy-report.js                         최근 30일
 *   node src/occupancy-report.js --period=week           이번 주 (월~오늘)
 *   node src/occupancy-report.js --period=month          이번 달 (1일~오늘)
 *   node src/occupancy-report.js --month=2026-02         특정 월 전체
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "포맷된 결과" }
 *   { success: false, message: "오류 내용" }
 *
 * 데이터 소스: state.db reservations (seen_only=0, status != 'cancelled')
 * 영업시간: 09:00 ~ 22:00 (13시간/일)
 */

'use strict';

const path = require('path');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);

// 영업시간: 09:00 ~ 22:00 → 슬롯 09~21 (총 13개)
const BIZ_START = 9;   // 포함
const BIZ_END   = 22;  // 미포함 (22:00 정각 마감)
const SLOTS     = Array.from({ length: BIZ_END - BIZ_START }, (_, i) => BIZ_START + i);

// ── 날짜 유틸 ──────────────────────────────────────────────────────────────

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function toDateStr(d) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + 'T00:00:00+09:00');
  const end = new Date(endStr   + 'T00:00:00+09:00');
  while (cur <= end) {
    dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── 시간 파싱 ──────────────────────────────────────────────────────────────

/** "HH:MM" → 분 단위 정수 */
function toMin(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 예약 [start, end)이 슬롯 [slotH, slotH+1)과 겹치는지 판단
 * 겹치는 분 수도 반환
 */
function overlapMin(startMin, endMin, slotH) {
  const slotStart = slotH * 60;
  const slotEnd   = (slotH + 1) * 60;
  const overlapStart = Math.max(startMin, slotStart);
  const overlapEnd   = Math.min(endMin,   slotEnd);
  return Math.max(0, overlapEnd - overlapStart);
}

// ── DB 조회 ────────────────────────────────────────────────────────────────

async function fetchReservations(startDate, endDate) {
  return pgPool.query(SCHEMA, `
    SELECT room, date, start_time, end_time
    FROM   reservations
    WHERE  seen_only = 0
      AND  status != 'cancelled'
      AND  date BETWEEN $1 AND $2
      AND  room IS NOT NULL AND room != ''
      AND  start_time IS NOT NULL AND end_time IS NOT NULL
    ORDER BY date, start_time
  `, [startDate, endDate]);
}

// ── 가동률 계산 ────────────────────────────────────────────────────────────

/**
 * 룸별 가동률
 * @returns {{ room, reservedMin, totalMin, rate }[] }
 */
function calcRoomOccupancy(rows, dates, rooms) {
  const bizMinPerDay = (BIZ_END - BIZ_START) * 60; // 780분
  const totalMin     = dates.length * bizMinPerDay;

  const reservedByRoom = {};
  for (const room of rooms) reservedByRoom[room] = 0;

  for (const r of rows) {
    if (!reservedByRoom.hasOwnProperty(r.room)) continue;
    const startMin = toMin(r.start_time);
    const endMin   = toMin(r.end_time);
    // 영업시간 내 클리핑
    const clampStart = Math.max(startMin, BIZ_START * 60);
    const clampEnd   = Math.min(endMin,   BIZ_END   * 60);
    if (clampEnd > clampStart) {
      reservedByRoom[r.room] += clampEnd - clampStart;
    }
  }

  return rooms.map(room => ({
    room,
    reservedMin: reservedByRoom[room],
    totalMin,
    rate: totalMin > 0 ? (reservedByRoom[room] / totalMin) * 100 : 0,
  }));
}

/**
 * 시간대별 가동률
 * 각 슬롯에서 (룸 수 × 일 수) 중 몇 분이 예약됐는지
 * @returns {{ slotH, reservedMin, totalMin, rate }[] }
 */
function calcSlotOccupancy(rows, dates, rooms) {
  const totalMin = dates.length * rooms.length * 60; // 슬롯당 가용 분

  const reservedBySlot = {};
  for (const s of SLOTS) reservedBySlot[s] = 0;

  for (const r of rows) {
    if (!rooms.includes(r.room)) continue;
    const startMin = toMin(r.start_time);
    const endMin   = toMin(r.end_time);
    for (const slotH of SLOTS) {
      const ov = overlapMin(startMin, endMin, slotH);
      if (ov > 0) reservedBySlot[slotH] += ov;
    }
  }

  return SLOTS.map(slotH => ({
    slotH,
    reservedMin: reservedBySlot[slotH],
    totalMin,
    rate: totalMin > 0 ? (reservedBySlot[slotH] / totalMin) * 100 : 0,
  }));
}

// ── 포맷 ──────────────────────────────────────────────────────────────────

function bar(rate, width = 12) {
  const filled = Math.round((rate / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatReport(label, roomStats, slotStats, totalRows, days) {
  const lines = [];
  lines.push(`📊 가동률 리포트 — ${label}`);
  lines.push(`   (${days}일 기간, 예약 ${totalRows}건)`);
  lines.push('');

  // ── 룸별 가동률 ──
  lines.push('▌ 룸별 가동률 (영업시간 09:00~22:00 기준)');
  for (const s of roomStats) {
    const h   = Math.floor(s.reservedMin / 60);
    const m   = s.reservedMin % 60;
    const pct = s.rate.toFixed(1).padStart(5);
    lines.push(`  ${s.room.padEnd(3)} ${bar(s.rate)} ${pct}%  (${h}h${m > 0 ? m + 'm' : ''})`);
  }
  lines.push('');

  // ── 시간대별 가동률 ──
  lines.push('▌ 시간대별 가동률 (전 룸 평균)');
  const peakSlots = slotStats.filter(s => s.rate > 0).sort((a, b) => b.rate - a.rate);
  const peak3 = peakSlots.slice(0, 3).map(s => `${s.slotH}시`).join(' > ');

  for (const s of slotStats) {
    const pct  = s.rate.toFixed(1).padStart(5);
    const tag  = s.rate >= 80 ? ' 🔥' : s.rate >= 50 ? ' ▲' : '';
    lines.push(`  ${String(s.slotH).padStart(2)}시  ${bar(s.rate)} ${pct}%${tag}`);
  }
  lines.push('');

  if (peak3) {
    lines.push(`  🏆 피크 시간대: ${peak3}`);
  }

  const avgRoom = roomStats.reduce((s, r) => s + r.rate, 0) / (roomStats.length || 1);
  lines.push(`  📈 전체 평균 가동률: ${avgRoom.toFixed(1)}%`);

  return lines.join('\n');
}

// ── 날짜 범위 결정 ────────────────────────────────────────────────────────

function resolveRange() {
  const now = nowKST();

  if (ARGS.month) {
    if (!/^\d{4}-\d{2}$/.test(ARGS.month)) {
      fail(`월 형식 오류: ${ARGS.month} (예: 2026-02)`);
    }
    const [y, m] = ARGS.month.split('-').map(Number);
    const start  = `${ARGS.month}-01`;
    const last   = new Date(y, m, 0).getDate();
    const end    = `${ARGS.month}-${String(last).padStart(2, '0')}`;
    return { start, end, label: `${y}년 ${m}월` };
  }

  if (ARGS.period === 'week') {
    const day  = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon  = new Date(now);
    mon.setDate(now.getDate() + diff);
    return { start: toDateStr(mon), end: toDateStr(now), label: '이번 주' };
  }

  if (ARGS.period === 'month') {
    const start = toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    return { start, end: toDateStr(now), label: `${now.getMonth() + 1}월` };
  }

  // 기본: 최근 30일
  const ago30 = new Date(now);
  ago30.setDate(now.getDate() - 29);
  return { start: toDateStr(ago30), end: toDateStr(now), label: '최근 30일' };
}

// ── 메인 ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    const { start, end, label } = resolveRange();
    const rows  = await fetchReservations(start, end);
    const dates = dateRange(start, end);
    const rooms = ['A1', 'A2', 'B'];

    const roomStats = calcRoomOccupancy(rows, dates, rooms);
    const slotStats = calcSlotOccupancy(rows, dates, rooms);

    const msg = formatReport(label, roomStats, slotStats, rows.length, dates.length);
    outputResult({ success: true, message: msg });
    process.exit(0);
  } catch (e) {
    fail(`가동률 조회 실패: ${e.message}`);
  }
})();
