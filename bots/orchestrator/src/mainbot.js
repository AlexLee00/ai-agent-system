#!/usr/bin/env node
'use strict';
const kst = require('../../../packages/core/lib/kst');

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
async function sendTelegram(input) {
  const message = typeof input === 'string' ? { text: input } : (input || {});
  const text = String(message.text || '').trim();
  if (!text) return false;

  const chunks = splitMessage(text);
  let allOk = true;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isSingleChunk = chunks.length === 1;
    const ok = isSingleChunk && message.replyMarkup
      ? await sender.sendWithOptions('general', chunk, {
        replyMarkup: message.replyMarkup,
        disableWebPagePreview: true,
      })
      : await sender.send('general', chunk);
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
const { isBriefingTime, flushMorningQueue, buildMorningBriefingWithOps } = require('../lib/night-handler');
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
        const ok = await sendTelegram(message);
        try {
          const ids = Array.isArray(processedItems)
            ? processedItems.map(i => i.id)
            : [processedItems.id];
          await pgPool.run('claude', `
            UPDATE mainbot_queue SET status = $2, processed_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
            WHERE id = ANY($1::int[])
          `, [ids, ok ? 'sent' : 'error']);
        } catch {}
        return ok;
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
  const kstHour = kst.currentHour();
  if (!isBriefingTime(_lastBriefHour)) return;
  _lastBriefHour = kstHour;

  const items = await flushMorningQueue();
  if (items.length === 0) return;

  const brief = await buildMorningBriefingWithOps(items);
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
    // bot_commands timeout 처리
    await pgPool.run('claude', `
      UPDATE bot_commands
      SET status='error',
          result='{"error":"timeout"}',
          done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE status='pending'
        AND (
          (to_bot = 'claude' AND created_at < to_char(now() - INTERVAL '15 minutes', 'YYYY-MM-DD HH24:MI:SS'))
          OR
          (to_bot <> 'claude' AND created_at < to_char(now() - INTERVAL '5 minutes', 'YYYY-MM-DD HH24:MI:SS'))
        )
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
