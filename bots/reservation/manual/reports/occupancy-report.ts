#!/usr/bin/env node

/**
 * occupancy-report.js — 룸별·시간대별 가동률 리포트
 */

'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');
const { buildReservationCliInsight } = require('../../lib/cli-insight');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);

const BIZ_START = 9;
const BIZ_END = 22;
const SLOTS = Array.from({ length: BIZ_END - BIZ_START }, (_, i) => BIZ_START + i);

type ReservationRow = {
  room: string;
  date: string;
  start_time: string;
  end_time: string;
};

type RoomStat = {
  room: string;
  reservedMin: number;
  totalMin: number;
  rate: number;
};

type SlotStat = {
  slotH: number;
  reservedMin: number;
  totalMin: number;
  rate: number;
};

type RangeInfo = {
  start: string;
  end: string;
  label: string;
};

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function toDateStr(d: Date) {
  return d.toLocaleDateString('en-CA');
}

function dateRange(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${startStr}T00:00:00+09:00`);
  const end = new Date(`${endStr}T00:00:00+09:00`);
  while (cur <= end) {
    dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function toMin(timeStr: string) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function overlapMin(startMin: number, endMin: number, slotH: number) {
  const slotStart = slotH * 60;
  const slotEnd = (slotH + 1) * 60;
  const overlapStart = Math.max(startMin, slotStart);
  const overlapEnd = Math.min(endMin, slotEnd);
  return Math.max(0, overlapEnd - overlapStart);
}

async function fetchReservations(startDate: string, endDate: string): Promise<ReservationRow[]> {
  return pgPool.query(SCHEMA, `
    SELECT room, date, start_time, end_time
    FROM reservations
    WHERE seen_only = 0
      AND status != 'cancelled'
      AND date BETWEEN $1 AND $2
      AND room IS NOT NULL AND room != ''
      AND start_time IS NOT NULL AND end_time IS NOT NULL
    ORDER BY date, start_time
  `, [startDate, endDate]);
}

function calcRoomOccupancy(rows: ReservationRow[], dates: string[], rooms: string[]): RoomStat[] {
  const bizMinPerDay = (BIZ_END - BIZ_START) * 60;
  const totalMin = dates.length * bizMinPerDay;

  const reservedByRoom: Record<string, number> = {};
  for (const room of rooms) reservedByRoom[room] = 0;

  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(reservedByRoom, r.room)) continue;
    const startMin = toMin(r.start_time);
    const endMin = toMin(r.end_time);
    const clampStart = Math.max(startMin, BIZ_START * 60);
    const clampEnd = Math.min(endMin, BIZ_END * 60);
    if (clampEnd > clampStart) {
      reservedByRoom[r.room] += clampEnd - clampStart;
    }
  }

  return rooms.map((room) => ({
    room,
    reservedMin: reservedByRoom[room],
    totalMin,
    rate: totalMin > 0 ? (reservedByRoom[room] / totalMin) * 100 : 0,
  }));
}

function calcSlotOccupancy(rows: ReservationRow[], dates: string[], rooms: string[]): SlotStat[] {
  const totalMin = dates.length * rooms.length * 60;

  const reservedBySlot: Record<number, number> = {};
  for (const s of SLOTS) reservedBySlot[s] = 0;

  for (const r of rows) {
    if (!rooms.includes(r.room)) continue;
    const startMin = toMin(r.start_time);
    const endMin = toMin(r.end_time);
    for (const slotH of SLOTS) {
      const ov = overlapMin(startMin, endMin, slotH);
      if (ov > 0) reservedBySlot[slotH] += ov;
    }
  }

  return SLOTS.map((slotH) => ({
    slotH,
    reservedMin: reservedBySlot[slotH],
    totalMin,
    rate: totalMin > 0 ? (reservedBySlot[slotH] / totalMin) * 100 : 0,
  }));
}

function bar(rate: number, width = 12) {
  const filled = Math.round((rate / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatReport(label: string, roomStats: RoomStat[], slotStats: SlotStat[], totalRows: number, days: number) {
  const lines: string[] = [];
  lines.push(`📊 가동률 리포트 — ${label}`);
  lines.push(`   (${days}일 기간, 예약 ${totalRows}건)`);
  lines.push('');
  lines.push('▌ 룸별 가동률 (영업시간 09:00~22:00 기준)');
  for (const s of roomStats) {
    const h = Math.floor(s.reservedMin / 60);
    const m = s.reservedMin % 60;
    const pct = s.rate.toFixed(1).padStart(5);
    lines.push(`  ${s.room.padEnd(3)} ${bar(s.rate)} ${pct}%  (${h}h${m > 0 ? `${m}m` : ''})`);
  }
  lines.push('');
  lines.push('▌ 시간대별 가동률 (전 룸 평균)');
  const peakSlots = slotStats.filter((s) => s.rate > 0).sort((a, b) => b.rate - a.rate);
  const peak3 = peakSlots.slice(0, 3).map((s) => `${s.slotH}시`).join(' > ');
  for (const s of slotStats) {
    const pct = s.rate.toFixed(1).padStart(5);
    const tag = s.rate >= 80 ? ' 🔥' : s.rate >= 50 ? ' ▲' : '';
    lines.push(`  ${String(s.slotH).padStart(2)}시  ${bar(s.rate)} ${pct}%${tag}`);
  }
  lines.push('');
  if (peak3) lines.push(`  🏆 피크 시간대: ${peak3}`);
  const avgRoom = roomStats.reduce((sum, r) => sum + r.rate, 0) / (roomStats.length || 1);
  lines.push(`  📈 전체 평균 가동률: ${avgRoom.toFixed(1)}%`);
  return lines.join('\n');
}

function resolveRange(): RangeInfo {
  const now = nowKST();

  if (ARGS.month) {
    if (!/^\d{4}-\d{2}$/.test(ARGS.month)) {
      fail(`월 형식 오류: ${ARGS.month} (예: 2026-02)`);
    }
    const [y, m] = ARGS.month.split('-').map(Number);
    const start = `${ARGS.month}-01`;
    const last = new Date(y, m, 0).getDate();
    const end = `${ARGS.month}-${String(last).padStart(2, '0')}`;
    return { start, end, label: `${y}년 ${m}월` };
  }

  if (ARGS.period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(now);
    mon.setDate(now.getDate() + diff);
    return { start: toDateStr(mon), end: toDateStr(now), label: '이번 주' };
  }

  if (ARGS.period === 'month') {
    const start = toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    return { start, end: toDateStr(now), label: `${now.getMonth() + 1}월` };
  }

  const ago30 = new Date(now);
  ago30.setDate(now.getDate() - 29);
  return { start: toDateStr(ago30), end: toDateStr(now), label: '최근 30일' };
}

(async () => {
  try {
    const { start, end, label } = resolveRange();
    const rows = await fetchReservations(start, end);
    const dates = dateRange(start, end);
    const rooms = ['A1', 'A2', 'B'];

    const roomStats = calcRoomOccupancy(rows, dates, rooms);
    const slotStats = calcSlotOccupancy(rows, dates, rooms);

    const msg = formatReport(label, roomStats, slotStats, rows.length, dates.length);
    const aiSummary = await buildReservationCliInsight({
      bot: 'occupancy-report',
      requestType: 'occupancy-report',
      title: '룸별·시간대별 가동률 리포트',
      data: {
        label,
        days: dates.length,
        reservationCount: rows.length,
        roomStats: roomStats.map((row) => ({ room: row.room, rate: Number(row.rate.toFixed(1)) })),
        peakSlots: slotStats
          .filter((slot) => slot.rate > 0)
          .sort((a, b) => b.rate - a.rate)
          .slice(0, 3)
          .map((slot) => ({ slot: slot.slotH, rate: Number(slot.rate.toFixed(1)) })),
      },
      fallback: rows.length > 0
        ? `최근 ${dates.length}일 기준 가동률 흐름이 정리돼 피크 시간대와 저활용 룸을 바로 비교하기 좋습니다.`
        : `집계 기간에 예약 데이터가 없어 가동률보다는 수집 상태를 먼저 확인하는 편이 좋습니다.`,
    });
    outputResult({ success: true, message: msg, aiSummary });
    process.exit(0);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    fail(`가동률 조회 실패: ${message}`);
  }
})();
