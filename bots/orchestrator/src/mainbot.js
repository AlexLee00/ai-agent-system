#!/usr/bin/env node
'use strict';

/**
 * src/mainbot.js — 메인봇 알람 큐 처리기
 *
 * 역할:
 *   1. mainbot_queue 폴링 — 봇 알람 수신 → filter.js → Telegram 발송
 *   2. 아침 브리핑 (08:00 KST) — 야간 보류 알람 발송
 *   3. 주기적 정리 (무음 만료, 확인 만료, bot_commands 타임아웃)
 *
 * NOTE: Telegram 폴링(사용자 명령 수신)은 OpenClaw/Jay가 담당.
 *       이 프로세스는 봇 알람 발송 전용.
 */

const fs       = require('fs');
const https    = require('https');
const path     = require('path');
const os       = require('os');
const Database = require('better-sqlite3');

// ─── 봇 정보 ─────────────────────────────────────────────────────────
const BOT_NAME = '제이';
const BOT_ID   = 'mainbot';

// ─── Self-lock ─────────────────────────────────────────────────────
const LOCK_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'mainbot.lock');

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

// ─── Secrets ─────────────────────────────────────────────────────────
let _secrets = null;
function loadSecrets() {
  if (_secrets) return _secrets;
  // 스카팀 secrets.json 공유 (같은 봇 토큰 / chat_id)
  const paths = [
    path.join(__dirname, '..', 'secrets.json'),
    path.join(__dirname, '..', '..', 'reservation', 'secrets.json'),
  ];
  for (const p of paths) {
    try { _secrets = JSON.parse(fs.readFileSync(p, 'utf8')); return _secrets; }
    catch {}
  }
  console.warn(`⚠️ secrets.json 없음 — 환경변수로 진행`);
  _secrets = {
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id:   process.env.TELEGRAM_CHAT_ID   || '***REMOVED***',
  };
  return _secrets;
}

// ─── DB ──────────────────────────────────────────────────────────────
const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
let _db = null;
function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ─── Telegram 발송 ───────────────────────────────────────────────────
const PENDING_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'mainbot-pending.jsonl');

async function tryTelegramSend(text, chatId) {
  const secrets  = loadSecrets();
  const token    = secrets.telegram_bot_token;
  if (!token) { console.warn('⚠️ telegram_bot_token 없음'); return false; }
  if (process.env.TELEGRAM_ENABLED === '0') return true;

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }));
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { const r = JSON.parse(raw); resolve(r.ok === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

const TG_MAX_LEN = 4096;

/**
 * 4096자 초과 메시지 분할 (줄 단위)
 * @param {string} text
 * @returns {string[]}
 */
function splitMessage(text) {
  if (text.length <= TG_MAX_LEN) return [text];
  const chunks = [];
  const lines  = text.split('\n');
  let   chunk  = '';
  for (const line of lines) {
    const append = (chunk ? '\n' : '') + line;
    if (chunk.length + append.length > TG_MAX_LEN) {
      if (chunk) chunks.push(chunk);
      // 단일 줄이 4096자 초과인 경우 강제 분할
      if (line.length > TG_MAX_LEN) {
        for (let i = 0; i < line.length; i += TG_MAX_LEN) {
          chunks.push(line.slice(i, i + TG_MAX_LEN));
        }
        chunk = '';
      } else {
        chunk = line;
      }
    } else {
      chunk += append;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function sendTelegram(text) {
  const secrets = loadSecrets();
  const chatId  = secrets.telegram_chat_id || '***REMOVED***';
  const chunks  = splitMessage(text);

  let allOk = true;
  for (const chunk of chunks) {
    let sent = false;
    for (let i = 0; i < 3; i++) {
      if (await tryTelegramSend(chunk, chatId)) { sent = true; break; }
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
    if (!sent) {
      allOk = false;
      try {
        fs.appendFileSync(PENDING_FILE, JSON.stringify({ text: chunk, chatId, ts: new Date().toISOString() }) + '\n');
      } catch {}
    }
    // 분할 전송 시 rate limit 방지 (1 msg/sec per chat)
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
  return allOk;
}

async function flushPendingTelegrams() {
  if (!fs.existsSync(PENDING_FILE)) return;
  try {
    const lines = fs.readFileSync(PENDING_FILE, 'utf8').split('\n').filter(Boolean);
    fs.unlinkSync(PENDING_FILE);
    for (const line of lines) {
      try {
        const { text, chatId } = JSON.parse(line);
        await tryTelegramSend(text, chatId);
        await new Promise(r => setTimeout(r, 200));
      } catch {}
    }
  } catch {}
}

// ─── 큐 폴링 (봇 알람 처리) ─────────────────────────────────────────
const { processItem }       = require('./filter');
const { cleanExpired: cleanMutes }   = require('../lib/mute-manager');
const { cleanExpired: cleanConfirms }= require('../lib/confirm');
const { isBriefingTime, flushMorningQueue, buildMorningBriefing } = require('../lib/night-handler');
const { runCommanderIdentityCheck, buildIdentityReport }          = require('../lib/identity-checker');

let _lastBriefHour = -1;

async function processQueue() {
  try {
    const pending = getDb().prepare(`
      SELECT * FROM mainbot_queue
      WHERE status = 'pending'
      ORDER BY alert_level DESC, created_at ASC
      LIMIT 20
    `).all();

    for (const item of pending) {
      const result = processItem(item, async (message, processedItems) => {
        await sendTelegram(message);
        try {
          // 배치 전체 항목 또는 단일 항목 일괄 status='sent' 처리
          const ids = Array.isArray(processedItems)
            ? processedItems.map(i => i.id)
            : [processedItems.id];
          const placeholders = ids.map(() => '?').join(',');
          getDb().prepare(`
            UPDATE mainbot_queue SET status = 'sent', processed_at = datetime('now')
            WHERE id IN (${placeholders})
          `).run(...ids);
        } catch {}
      });

      // 상태 업데이트 — batched도 즉시 'batched'로 표시 (pending 재처리 방지)
      try {
        getDb().prepare(`
          UPDATE mainbot_queue SET status = ?, processed_at = datetime('now') WHERE id = ?
        `).run(result, item.id);
      } catch {}
    }
  } catch (e) {
    console.error(`[mainbot] 큐 처리 오류:`, e.message);
  }
}

async function runMorningBriefing() {
  const kstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
  if (!isBriefingTime(_lastBriefHour)) return;
  _lastBriefHour = kstHour;

  const items = flushMorningQueue();
  if (items.length === 0) return;

  const brief = buildMorningBriefing(items);
  if (brief) await sendTelegram(brief);
}

// ─── 주기적 정리 ─────────────────────────────────────────────────────
let _cleanupCounter = 0;
function runCleanup() {
  _cleanupCounter++;
  if (_cleanupCounter % 60 !== 0) return; // 1분(60 * 1초)마다
  try {
    cleanMutes();
    cleanConfirms();
    // 5분 초과 pending bot_commands → error 처리
    getDb().prepare(`
      UPDATE bot_commands SET status='error', result='{"error":"timeout"}'
      WHERE status='pending' AND created_at < datetime('now', '-5 minutes')
    `).run();
    // 1시간 초과 batched mainbot_queue → sent 처리 (배치 전송 후 상태 미갱신 항목)
    getDb().prepare(`
      UPDATE mainbot_queue SET status='sent'
      WHERE status='batched' AND processed_at < datetime('now', '-1 hour')
    `).run();
  } catch {}
}

// ─── 팀장 정체성 점검 (6시간 주기) ──────────────────────────────────
// 2초 루프 기준: 30 tick = 1분, 10800 tick = 6시간
let _identityCounter = 0;

async function runIdentityCheck() {
  try {
    const results = runCommanderIdentityCheck();
    const report  = buildIdentityReport(results);
    if (report) {
      console.log(`[mainbot] 정체성 점검 이슈 발견 → Telegram 보고`);
      await sendTelegram(report);
    } else {
      console.log(`[mainbot] 정체성 점검: 모든 팀장 정상`);
    }
  } catch (e) {
    console.error(`[mainbot] 정체성 점검 오류:`, e.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
async function mainLoop() {
  // 큐 폴링 (2초 간격)
  await processQueue();
  await runMorningBriefing();
  runCleanup();

  // 팀장 정체성 점검: 시작 1분 후 첫 실행, 이후 6시간마다
  _identityCounter++;
  if (_identityCounter % 10800 === 30) await runIdentityCheck();
}

async function main() {
  acquireLock();
  await flushPendingTelegrams();

  console.log(`🤖 ${BOT_NAME} 알람 큐 처리기 시작 (PID: ${process.pid})`);

  // 큐 처리 루프 (2초 간격)
  while (true) {
    try { await mainLoop(); }
    catch (e) { console.error(`[queue] 처리 오류:`, e.message); }
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(e => {
  console.error(`[mainbot] 치명적 오류:`, e);
  process.exit(1);
});
