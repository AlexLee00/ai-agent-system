#!/usr/bin/env node
'use strict';
/**
 * scripts/manual-batch-reserve.js — 대리예약 배치 스크립트
 *
 * 1단계: pickko-accurate.ts/js shim → 픽코 예약 등록
 *   - 슬롯 사용 중이면 A1→A2→B 순으로 자동 폴백
 * 2단계: pickko-kiosk-monitor.ts/js shim --block-slot → 네이버 예약불가 처리
 *
 * 실행: tsx bots/reservation/scripts/manual-batch-reserve.ts
 */

const { spawn } = require('child_process');
const path = require('path');
const { releasePickkoLock } = require('../lib/state-bus');

type Booking = {
  name: string;
  phone: string;
  date: string;
  start: string;
  end: string;
  room: 'A1' | 'A2' | 'B';
};

// ── 예약 목록 (수정 후 실행) ─────────────────────────────────────────
const BOOKINGS: Booking[] = [
  { name: '민경수', phone: '01027922221', date: '2026-03-11', start: '10:30', end: '12:30', room: 'A1' },
  { name: '민경수', phone: '01027922221', date: '2026-03-11', start: '12:30', end: '14:30', room: 'A2' },
  { name: '민경수', phone: '01027922221', date: '2026-03-13', start: '12:00', end: '14:00', room: 'A1' },
  { name: '민경수', phone: '01027922221', date: '2026-03-13', start: '14:00', end: '15:00', room: 'A1' },
  { name: '민경수', phone: '01027922221', date: '2026-03-13', start: '19:00', end: '21:00', room: 'A1' },
  { name: '민경수', phone: '01027922221', date: '2026-03-14', start: '10:00', end: '12:00', room: 'A1' },
];

// 폴백 순서
const ROOM_FALLBACK: Record<Booking['room'], Booking['room'][]> = {
  A1: ['A1', 'A2', 'B'],
  A2: ['A2', 'B'],
  B: ['B'],
};

const PICKKO_SCRIPT  = path.join(__dirname, '../manual/reservation/pickko-accurate.js');
const KIOSK_MONITOR  = path.join(__dirname, '../auto/monitors/pickko-kiosk-monitor.js');

// ── 유틸 ─────────────────────────────────────────────────────────────

function runNode(scriptPath: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: path.dirname(scriptPath),
      stdio: 'inherit',
      env: { ...process.env, MODE: 'ops', HOLD_BROWSER_ON_ERROR: '0' },
    });
    child.on('close', (code) => resolve(code));
    child.on('error', reject);
  });
}

// 슬롯 사용 중 오류인지 판별 (exit 1 + OPS-CRITICAL 시간선택실패)
// pickko-accurate.js는 슬롯 사용 중이면 exit 1 반환
// exit 0=성공, exit 1=실패(슬롯사용중 포함), exit 2=시간경과
const SLOT_FAIL_EXIT = 1;

// ── 메인 ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`대리예약 배치: ${BOOKINGS.length}건`);
  console.log(`${'═'.repeat(60)}`);

  let pickkoOk = 0, pickkoFail = 0;
  let naverOk  = 0, naverFail  = 0;

  for (const b of BOOKINGS) {
    const baseLabel = `${b.date} ${b.start}~${b.end} (${b.name})`;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📋 처리 중: ${baseLabel}`);
    console.log(`${'─'.repeat(60)}`);

    // ── Step 1: 픽코 예약 (A1→A2→B 폴백) ────────────────────────────
    const fallbacks = ROOM_FALLBACK[b.room] || [b.room];
    let bookedRoom = null;

    for (const room of fallbacks) {
      console.log(`\n[1/2] 픽코 예약 등록 — ${room}룸 시도`);

      // 이전 실행에서 락이 남아있을 수 있으므로 보장
      try { await releasePickkoLock('manual'); } catch {}

      const code = await runNode(PICKKO_SCRIPT, [
        `--phone=${b.phone}`,
        `--date=${b.date}`,
        `--start=${b.start}`,
        `--end=${b.end}`,
        `--room=${room}`,
        `--name=${b.name}`,
      ]).catch(() => 1);

      // 락 잔류 방지
      try { await releasePickkoLock('manual'); } catch {}

      if (code === 0 || code === 2) {
        bookedRoom = room;
        console.log(`✅ 픽코 성공 (exit ${code}) — ${room}룸`);
        pickkoOk++;
        break;
      }

      console.log(`⚠️  ${room}룸 실패 (exit ${code}) → 다음 룸 시도`);
    }

    if (!bookedRoom) {
      console.error(`❌ 픽코 실패 — 모든 룸 시도 실패: ${baseLabel}`);
      pickkoFail++;
      continue;
    }

    // ── Step 2: 네이버 예약불가 (실제 예약된 룸으로) ──────────────────
    console.log(`\n[2/2] 네이버 예약불가 처리 — ${bookedRoom}룸`);
    const naverCode = await runNode(KIOSK_MONITOR, [
      '--block-slot',
      `--phone=${b.phone}`,
      `--date=${b.date}`,
      `--start=${b.start}`,
      `--end=${b.end}`,
      `--room=${bookedRoom}`,
      `--name=${b.name}`,
    ]).catch(() => 1);

    if (naverCode === 0) {
      console.log(`✅ 네이버 차단 완료`);
      naverOk++;
    } else {
      console.error(`❌ 네이버 차단 실패 (exit ${naverCode})`);
      naverFail++;
    }
  }

  // ── 결과 요약 ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`배치 완료 결과`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`픽코 예약: ✅ ${pickkoOk}건 / ❌ ${pickkoFail}건`);
  console.log(`네이버 차단: ✅ ${naverOk}건 / ❌ ${naverFail}건`);
  console.log(`${'═'.repeat(60)}\n`);

  if (pickkoFail > 0 || naverFail > 0) process.exit(1);
}

module.exports = {
  BOOKINGS,
  ROOM_FALLBACK,
  runNode,
  main,
};

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ 배치 실행 오류: ${message}`);
    process.exit(1);
  });
}
