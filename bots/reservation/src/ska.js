#!/usr/bin/env node
'use strict';

/**
 * src/ska.js — 스카 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: query_reservations, query_today_stats, query_alerts, restart_andy, restart_jimmy
 *   - 결과를 bot_commands.status='done', result=JSON으로 업데이트
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME = '스카';
const BOT_ID   = 'ska';

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'ska.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try { process.kill(Number(old), 0); console.error(`${BOT_NAME} 이미 실행 중 (PID: ${old})`); process.exit(1); }
    catch { fs.unlinkSync(LOCK_PATH); }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── DB ──────────────────────────────────────────────────────────────
const CMD_DB_PATH   = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
const STATE_DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'state.db');

let _cmdDb   = null;
let _stateDb = null;

function getCmdDb() {
  if (_cmdDb) return _cmdDb;
  _cmdDb = new Database(CMD_DB_PATH);
  _cmdDb.pragma('journal_mode = WAL');
  return _cmdDb;
}

function getStateDb() {
  if (_stateDb) return _stateDb;
  _stateDb = new Database(STATE_DB_PATH, { readonly: true });
  return _stateDb;
}

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 오늘 예약 현황 조회
 */
function handleQueryReservations(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  try {
    const rows = getStateDb().prepare(`
      SELECT name_enc, date, start_time, end_time, room, status
      FROM reservations
      WHERE date = ?
      ORDER BY start_time
    `).all(date);

    if (rows.length === 0) {
      return { ok: true, date, count: 0, message: `${date} 예약 없음` };
    }

    const list = rows.map(r =>
      `${r.start_time}~${r.end_time} [${r.room}] ${r.status}`
    );
    return { ok: true, date, count: rows.length, reservations: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 오늘 매출/예약수 조회
 */
function handleQueryTodayStats(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  try {
    const summary = getStateDb().prepare(`
      SELECT total_amount, entries_count FROM daily_summary WHERE date = ?
    `).get(date);

    if (!summary) {
      return { ok: true, date, message: `${date} 매출 데이터 없음` };
    }

    return {
      ok: true,
      date,
      total_amount: summary.total_amount,
      entries_count: summary.entries_count,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 미해결 알람 조회
 */
function handleQueryAlerts(args) {
  try {
    const limit = args.limit || 10;
    const rows = getStateDb().prepare(`
      SELECT type, title, message, timestamp
      FROM alerts
      WHERE resolved = 0
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return { ok: true, count: rows.length, alerts: rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 앤디 (네이버 모니터) 재시작
 */
function handleRestartAndy() {
  try {
    execSync(`launchctl kickstart -k gui/${process.getuid()} ai.ska.naver-monitor`, { timeout: 10000 });
    return { ok: true, message: '앤디 재시작 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 지미 (키오스크 모니터) 재시작
 */
function handleRestartJimmy() {
  try {
    execSync(`launchctl kickstart -k gui/${process.getuid()} ai.ska.kiosk-monitor`, { timeout: 10000 });
    return { ok: true, message: '지미 재시작 완료' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  query_reservations: handleQueryReservations,
  query_today_stats:  handleQueryTodayStats,
  query_alerts:       handleQueryAlerts,
  restart_andy:       handleRestartAndy,
  restart_jimmy:      handleRestartJimmy,
};

async function processCommands() {
  try {
    const pending = getCmdDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `).all(BOT_ID);

    for (const cmd of pending) {
      // running 상태로 전환
      getCmdDb().prepare(`
        UPDATE bot_commands SET status = 'running' WHERE id = ?
      `).run(cmd.id);

      let result;
      try {
        const args = JSON.parse(cmd.args || '{}');
        const handler = HANDLERS[cmd.command];

        if (!handler) {
          result = { ok: false, error: `알 수 없는 명령: ${cmd.command}` };
        } else {
          result = await Promise.resolve(handler(args));
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      // 완료 처리
      getCmdDb().prepare(`
        UPDATE bot_commands
        SET status = ?, result = ?, done_at = datetime('now')
        WHERE id = ?
      `).run(result.ok ? 'done' : 'error', JSON.stringify(result), cmd.id);

      console.log(`[스카] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[스카] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────

async function main() {
  acquireLock();
  console.log(`🤖 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[스카] 루프 오류:`, e.message); }
    await new Promise(r => setTimeout(r, 30000)); // 30초 간격
  }
}

main().catch(e => {
  console.error(`[스카] 치명적 오류:`, e);
  process.exit(1);
});
