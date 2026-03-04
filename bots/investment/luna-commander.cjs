#!/usr/bin/env node
'use strict';

/**
 * luna-commander.js — 루나 팀장 봇
 *
 * 역할:
 *   - bot_commands 테이블 폴링 (30초 간격)
 *   - 명령 처리: pause_trading, resume_trading, force_report, get_status
 *   - 일시정지: ~/.openclaw/workspace/luna-paused.flag 파일로 제어
 *     → crypto.js가 시작 시 이 파일 존재 여부로 스킵 판단
 *
 * NOTE: Telegram 수신/발신 없음. 제이(Jay, OpenClaw)의 명령을 받아 실행.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync } = require('child_process');
const Database     = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME = '루나';
const BOT_ID   = 'luna';

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH  = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-commander.lock');
const PAUSE_FLAG = path.join(os.homedir(), '.openclaw', 'workspace', 'luna-paused.flag');

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

// ─── 명령 핸들러 ─────────────────────────────────────────────────────

/**
 * 거래 일시정지 — luna-paused.flag 생성
 */
function handlePauseTrading(args) {
  try {
    const reason = args.reason || '제이 명령';
    fs.writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason }));
    return { ok: true, message: `거래 일시정지 설정 (이유: ${reason})\n다음 사이클부터 스킵됩니다.` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 거래 재개 — luna-paused.flag 삭제
 */
function handleResumeTrading() {
  try {
    if (!fs.existsSync(PAUSE_FLAG)) {
      return { ok: true, message: '이미 실행 중 상태입니다.' };
    }
    fs.unlinkSync(PAUSE_FLAG);
    return { ok: true, message: '거래 재개 완료. 다음 사이클(최대 5분)부터 정상 실행됩니다.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 투자 리포트 강제 실행
 */
function handleForceReport() {
  try {
    const nodeExe  = process.execPath;
    const reportJs = path.join(__dirname, 'team', 'reporter.js');

    // reporter.js는 ESM — node --input-type=module 불필요 (파일 직접 실행)
    execSync(`${nodeExe} ${reportJs} --telegram`, {
      cwd:     __dirname,
      timeout: 120000,
      env:     { ...process.env },
    });
    return { ok: true, message: '투자 리포트 텔레그램 발송 완료' };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString()?.slice(0, 200) || e.message };
  }
}

/**
 * 루나팀 현재 상태 조회
 */
function handleGetStatus() {
  try {
    const stateFile = path.join(os.homedir(), '.openclaw', 'investment-state.json');
    if (!fs.existsSync(stateFile)) {
      return { ok: true, status: 'unknown', message: '상태 파일 없음' };
    }
    const state   = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const paused  = fs.existsSync(PAUSE_FLAG);
    const pauseInfo = paused ? JSON.parse(fs.readFileSync(PAUSE_FLAG, 'utf8')) : null;

    return {
      ok: true,
      paused,
      paused_at:   pauseInfo?.paused_at,
      pause_reason: pauseInfo?.reason,
      last_cycle:  state.lastCycleAt > 0
        ? new Date(state.lastCycleAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
        : '없음',
      balance_usdt: state.balance_usdt,
      mode:         state.mode || 'unknown',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── 명령 디스패처 ────────────────────────────────────────────────────

const HANDLERS = {
  pause_trading:  handlePauseTrading,
  resume_trading: handleResumeTrading,
  force_report:   handleForceReport,
  get_status:     handleGetStatus,
};

async function processCommands() {
  try {
    const pending = getDb().prepare(`
      SELECT * FROM bot_commands
      WHERE to_bot = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
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

      console.log(`[루나] ${cmd.command} → ${result.ok ? 'done' : 'error'}`);
    }
  } catch (e) {
    console.error(`[루나] 명령 처리 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────

async function main() {
  acquireLock();
  console.log(`🌙 ${BOT_NAME} 팀장봇 시작 (PID: ${process.pid})`);

  while (true) {
    try { await processCommands(); }
    catch (e) { console.error(`[루나] 루프 오류:`, e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(e => {
  console.error(`[루나] 치명적 오류:`, e);
  process.exit(1);
});
