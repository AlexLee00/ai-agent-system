#!/usr/bin/env node
'use strict';

/**
 * src/mainbot.js — 메인봇 (오케스트레이터) 진입점
 *
 * 역할:
 *   1. Telegram polling — 사용자 명령 수신 → router.js
 *   2. mainbot_queue 폴링 — 봇 알람 수신 → filter.js → Telegram 발송
 *   3. 아침 브리핑 (08:00 KST) — 야간 보류 알람 발송
 *   4. 주기적 정리 (무음 만료, 확인 만료)
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
    const body = Buffer.from(JSON.stringify({ chat_id: chatId, text }));
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

async function sendTelegram(text) {
  const secrets = loadSecrets();
  const chatId  = secrets.telegram_chat_id || '***REMOVED***';

  for (let i = 0; i < 3; i++) {
    if (await tryTelegramSend(text, chatId)) return true;
    if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }

  // pending queue에 저장
  try {
    fs.appendFileSync(PENDING_FILE, JSON.stringify({ text, chatId, ts: new Date().toISOString() }) + '\n');
  } catch {}
  return false;
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

// ─── Telegram Polling ────────────────────────────────────────────────
const { route } = require('./router');

let _lastUpdateId = 0;

async function pollTelegram() {
  const secrets = loadSecrets();
  const token   = secrets.telegram_bot_token;
  if (!token) return;

  return new Promise((resolve) => {
    const params = new URLSearchParams({
      offset:  String(_lastUpdateId + 1),
      timeout: '20',
      allowed_updates: JSON.stringify(['message']),
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/getUpdates?${params}`,
      method:   'GET',
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', async () => {
        try {
          const r = JSON.parse(raw);
          if (!r.ok || !r.result?.length) { resolve(); return; }

          for (const update of r.result) {
            _lastUpdateId = Math.max(_lastUpdateId, update.update_id);
            const msg = update.message;
            if (msg?.text) {
              await route(msg, (text) => sendTelegram(text));
            }
          }
        } catch {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.setTimeout(25000, () => { req.destroy(); resolve(); });
    req.end();
  });
}

// ─── 큐 폴링 (봇 알람 처리) ─────────────────────────────────────────
const { processItem }       = require('./filter');
const { cleanExpired: cleanMutes }   = require('../lib/mute-manager');
const { cleanExpired: cleanConfirms }= require('../lib/confirm');
const { isBriefingTime, flushMorningQueue, buildMorningBriefing } = require('../lib/night-handler');

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
      const result = processItem(item, async (message, processedItem) => {
        await sendTelegram(message);
        try {
          getDb().prepare(`
            UPDATE mainbot_queue SET status = 'sent', processed_at = datetime('now') WHERE id = ?
          `).run(processedItem.id);
        } catch {}
      });

      // 상태 업데이트
      if (result !== 'batched') {
        try {
          getDb().prepare(`
            UPDATE mainbot_queue SET status = ?, processed_at = datetime('now') WHERE id = ?
          `).run(result, item.id);
        } catch {}
      }
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
  } catch {}
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
let _running = false;

async function mainLoop() {
  // 큐 폴링 (2초 간격)
  await processQueue();
  await runMorningBriefing();
  runCleanup();
}

async function main() {
  acquireLock();
  await flushPendingTelegrams();

  console.log(`🤖 ${BOT_NAME} 시작 (PID: ${process.pid})`);
  await sendTelegram(`🤖 ${BOT_NAME} 시작됨\n버전: 1.0.0 | PID: ${process.pid}`);

  // Telegram polling 루프 (비동기, 20초 long-poll)
  const telegramLoop = async () => {
    while (true) {
      try { await pollTelegram(); }
      catch (e) { console.error(`[telegram] polling 오류:`, e.message); }
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  // 큐 처리 루프 (2초 간격)
  const queueLoop = async () => {
    while (true) {
      try { await mainLoop(); }
      catch (e) { console.error(`[queue] 처리 오류:`, e.message); }
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  // 동시 실행
  await Promise.all([telegramLoop(), queueLoop()]);
}

main().catch(e => {
  console.error(`[mainbot] 치명적 오류:`, e);
  process.exit(1);
});
