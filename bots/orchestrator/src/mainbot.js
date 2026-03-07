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
const path     = require('path');
const os       = require('os');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const sender   = require('../../../packages/core/lib/telegram-sender');
const router   = require('./router');

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

// ─── Telegram 발송 ───────────────────────────────────────────────────

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

/**
 * 텔레그램 발송 — 📌 일반 Forum Topic 경유
 * 4096자 초과 시 분할 전송
 */
async function sendTelegram(text) {
  const chunks = splitMessage(text);
  let allOk = true;
  for (const chunk of chunks) {
    const ok = await sender.send('general', chunk);
    if (!ok) allOk = false;
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
  return allOk;
}

async function flushPendingTelegrams() {
  return sender.flushPending();
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
    const pending = await pgPool.query('claude', `
      SELECT * FROM mainbot_queue
      WHERE status = 'pending'
      ORDER BY alert_level DESC, created_at ASC
      LIMIT 20
    `);

    for (const item of pending) {
      const result = await processItem(item, async (message, processedItems) => {
        await sendTelegram(message);
        try {
          const ids = Array.isArray(processedItems)
            ? processedItems.map(i => i.id)
            : [processedItems.id];
          await pgPool.run('claude', `
            UPDATE mainbot_queue SET status = 'sent', processed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
            WHERE id = ANY($1::int[])
          `, [ids]);
        } catch {}
      });

      try {
        await pgPool.run('claude', `
          UPDATE mainbot_queue SET status = $1, processed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2
        `, [result, item.id]);
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
async function runCleanup() {
  _cleanupCounter++;
  if (_cleanupCounter % 60 !== 0) return; // 1분(60 * 1초)마다
  try {
    await cleanMutes();
    await cleanConfirms();
    // 5분 초과 pending bot_commands → error 처리
    await pgPool.run('claude', `
      UPDATE bot_commands SET status='error', result='{"error":"timeout"}'
      WHERE status='pending' AND created_at < to_char(now() - INTERVAL '5 minutes', 'YYYY-MM-DD HH24:MI:SS')
    `);
    // 1시간 초과 batched mainbot_queue → sent 처리
    await pgPool.run('claude', `
      UPDATE mainbot_queue SET status='sent'
      WHERE status='batched' AND processed_at < to_char(now() - INTERVAL '1 hour', 'YYYY-MM-DD HH24:MI:SS')
    `);
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

// ─── Telegram 수신 폴링 (마스터 명령 처리) ──────────────────────────

// Secrets 캐시 (bot_token 로드용 — telegram-sender와 별도 관리)
let _rcvSecrets = null;
function _getRcvSecrets() {
  if (!_rcvSecrets) {
    try { _rcvSecrets = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'reservation', 'secrets.json'), 'utf8'
    )); } catch { _rcvSecrets = {}; }
  }
  return _rcvSecrets;
}

let _tgOffset = 0;

async function tgPost(method, body) {
  const token = _getRcvSecrets().telegram_bot_token;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(35000),
    });
    return await res.json();
  } catch { return null; }
}

/**
 * 마스터 메시지에 답장 발송
 * - 같은 Forum Topic에 answer (message_thread_id 유지)
 * - 원본 메시지에 reply (reply_to_message_id)
 * - Markdown 파싱 오류 시 plain text로 fallback
 */
async function sendReplyTo(msg, text) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id:             msg.chat.id,
      text:                chunks[i],
      parse_mode:          'Markdown',
      reply_to_message_id: msg.message_id,
    };
    if (msg.message_thread_id) payload.message_thread_id = msg.message_thread_id;
    const r = await tgPost('sendMessage', payload);
    // Markdown 파싱 오류 → plain text 재시도
    if (!r?.ok && r?.error_code === 400) {
      delete payload.parse_mode;
      await tgPost('sendMessage', payload);
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1100));
  }
}

async function pollTelegramUpdates() {
  const result = await tgPost('getUpdates', {
    offset:          _tgOffset,
    timeout:         30,
    allowed_updates: ['message'],
  });
  if (!result?.ok || !result.result?.length) return;

  for (const update of result.result) {
    _tgOffset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;

    // 그룹 채팅 슬래시 명령 정규화: /status@BotName → /status
    if (msg.text.startsWith('/')) {
      msg.text = msg.text.replace(/@\w+/, '').trim();
    }

    // router.route: isAuthorized + parseIntent + handleIntent + sendReply
    router.route(msg, (text) => sendReplyTo(msg, text)).catch(e => {
      console.error('[telegram-recv] 라우팅 오류:', e.message);
    });
  }
}

async function telegramPollLoop() {
  const token = _getRcvSecrets().telegram_bot_token;
  if (!token) {
    console.warn('[telegram-recv] telegram_bot_token 없음 — 수신 비활성화');
    return;
  }

  // 시작 시 미처리 메시지 drain (재시작 후 old 메시지 skip)
  const drain = await tgPost('getUpdates', { offset: _tgOffset, timeout: 0, limit: 100 });
  if (drain?.ok && drain.result?.length) {
    _tgOffset = drain.result[drain.result.length - 1].update_id + 1;
    console.log(`[telegram-recv] 기존 메시지 ${drain.result.length}건 skip (offset=${_tgOffset})`);
  }

  console.log('[telegram-recv] 수신 폴링 시작');
  while (true) {
    try {
      await pollTelegramUpdates();
    } catch (e) {
      console.error('[telegram-recv] 폴링 오류:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────
async function mainLoop() {
  // 큐 폴링 (2초 간격)
  await processQueue();
  await runMorningBriefing();
  await runCleanup();

  // 팀장 정체성 점검: 시작 1분 후 첫 실행, 이후 6시간마다
  _identityCounter++;
  if (_identityCounter % 10800 === 30) await runIdentityCheck();
}

async function main() {
  acquireLock();
  await flushPendingTelegrams();

  console.log(`🤖 ${BOT_NAME} 알람 큐 처리기 시작 (PID: ${process.pid})`);

  // 텔레그램 수신 폴링 (병렬 실행 — 마스터 명령 처리)
  telegramPollLoop().catch(e => console.error('[telegram-poll] 치명 오류:', e));

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
