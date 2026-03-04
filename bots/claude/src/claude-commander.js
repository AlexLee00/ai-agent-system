#!/usr/bin/env node
'use strict';

/**
 * src/claude-commander.js — 클로드팀 커맨더 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: run_check, run_full, run_fix, daily_report, run_archer
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync } = require('child_process');
const Database     = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME = '클로드';
const BOT_ID   = 'claude';

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-commander.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try { process.kill(Number(old), 0); console.error(`${BOT_NAME} 커맨더 이미 실행 중 (PID: ${old})`); process.exit(1); }
    catch { fs.unlinkSync(LOCK_PATH); }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── DB ──────────────────────────────────────────────────────────────
const CMD_DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
let _db = null;
function getDb() {
  if (_db) return _db;
  _db = new Database(CMD_DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ─── 명령 실행 헬퍼 ──────────────────────────────────────────────────
const NODE    = process.execPath;
const DEXTER  = path.join(__dirname, 'dexter.js');
const ARCHER  = path.join(__dirname, 'archer.js');
const CWD     = path.join(__dirname, '..');

function runScript(script, flags = '') {
  execSync(`${NODE} ${script} ${flags}`, {
    cwd:     CWD,
    timeout: 300000, // 최대 5분
    env:     { ...process.env },
  });
}

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 덱스터 기본 점검
 */
function handleRunCheck() {
  try {
    runScript(DEXTER, '--telegram');
    return { ok: true, message: '덱스터 기본 점검 완료. 이상 시 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 전체 점검 (npm audit 포함)
 */
function handleRunFull() {
  try {
    runScript(DEXTER, '--full --telegram');
    return { ok: true, message: '덱스터 전체 점검 완료 (npm audit 포함).' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 자동 수정
 */
function handleRunFix() {
  try {
    runScript(DEXTER, '--fix --telegram');
    return { ok: true, message: '덱스터 자동 수정 완료. 결과 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 덱스터 일일 보고
 */
function handleDailyReport() {
  try {
    runScript(DEXTER, '--daily-report --telegram');
    return { ok: true, message: '일일 보고 텔레그램 발송 완료.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

/**
 * 아처 기술 소화 실행
 */
function handleRunArcher() {
  try {
    runScript(ARCHER, '--telegram');
    return { ok: true, message: '아처 기술 소화 완료. 텔레그램으로 보고됨.' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 300) || e.message };
  }
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  run_check:    handleRunCheck,
  run_full:     handleRunFull,
  run_fix:      handleRunFix,
  daily_report: handleDailyReport,
  run_archer:   handleRunArcher,
};

async function processCommands() {
  try {
    const pending = getDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 3
    `).all(BOT_ID);

    for (const cmd of pending) {
      getDb().prepare(`
        UPDATE bot_commands SET status = 'running' WHERE id = ?
      `).run(cmd.id);

      let result;
      try {
        const args    = JSON.parse(cmd.args || '{}');
        const handler = HANDLERS[cmd.command];

        if (!handler) {
          result = { ok: false, error: `알 수 없는 명령: ${cmd.command}` };
        } else {
          result = await Promise.resolve(handler(args));
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      getDb().prepare(`
        UPDATE bot_commands
        SET status = ?, result = ?, done_at = datetime('now')
        WHERE id = ?
      `).run(result.ok ? 'done' : 'error', JSON.stringify(result), cmd.id);

      console.log(`[클로드] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[클로드] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────

async function main() {
  acquireLock();
  console.log(`🤖 ${BOT_NAME} 팀 커맨더 시작 (PID: ${process.pid})`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[클로드] 루프 오류:`, e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(e => {
  console.error(`[클로드] 치명적 오류:`, e);
  process.exit(1);
});
