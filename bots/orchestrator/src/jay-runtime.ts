// @ts-nocheck
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const kst      = require('../../../packages/core/lib/kst');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const sender   = require('../../../packages/core/lib/telegram-sender');

/**
 * Jay runtime
 *
 * This is the live orchestrator housekeeping loop. The old "mainbot" queue
 * consumer has been retired from runtime; alert fanout now goes through Hub
 * alarm / Telegram topic paths.
 *
 * Responsibilities kept here:
 *   1. flush pending Telegram messages on start
 *   2. send morning summaries for deferred night alerts
 *   3. clean expired mute/confirm state and timed-out bot_commands
 *   4. run periodic commander identity checks
 */

const BOT_NAME = '제이';
const RUNTIME_DIR = process.env.JAY_RUNTIME_DIR
  || process.env.HUB_RUNTIME_DIR
  || path.join(os.homedir(), '.ai-agent-system', 'jay');
const LOCK_PATH = path.join(RUNTIME_DIR, 'jay-runtime.lock');

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function acquireLock() {
  ensureRuntimeDir();
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try {
      process.kill(Number(old), 0);
      console.error(`${BOT_NAME} runtime already running (PID: ${old})`);
      process.exit(1);
    } catch {
      fs.unlinkSync(LOCK_PATH);
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(signal => process.on(signal, () => process.exit(0)));
}

const TG_MAX_LEN = 4096;

function splitMessage(text) {
  if (text.length <= TG_MAX_LEN) return [text];
  const chunks = [];
  const lines  = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    const append = (chunk ? '\n' : '') + line;
    if (chunk.length + append.length > TG_MAX_LEN) {
      if (chunk) chunks.push(chunk);
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

async function sendTelegram(input) {
  const message = typeof input === 'string' ? { text: input } : (input || {});
  const text = String(message.text || '').trim();
  if (!text) return false;
  const topicTeam = normalizeTopicTeam(message.team);

  const chunks = splitMessage(text);
  let allOk = true;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isSingleChunk = chunks.length === 1;
    const ok = isSingleChunk && message.replyMarkup
      ? await sender.sendWithOptions(topicTeam, chunk, {
        replyMarkup: message.replyMarkup,
        disableWebPagePreview: true,
      })
      : await sender.sendBuffered(topicTeam, chunk);
    if (!ok) allOk = false;
    if (chunks.length > 1) await new Promise(resolve => setTimeout(resolve, 1100));
  }
  return allOk;
}

function normalizeTopicTeam(team = 'general') {
  const normalized = String(team || 'general').trim().toLowerCase();
  if (normalized === 'reservation') return 'ska';
  if (normalized === 'investment') return 'luna';
  if (normalized === 'claude') return 'claude-lead';
  return normalized || 'general';
}

async function flushPendingTelegrams() {
  return sender.flushPending();
}

const { cleanExpired: cleanMutes } = require('../lib/mute-manager');
const { cleanExpired: cleanConfirms } = require('../lib/confirm');
const { isBriefingTime, flushMorningQueue, buildMorningBriefingWithOps } = require('../lib/night-handler');
const { runCommanderIdentityCheck, buildIdentityReport } = require('../lib/identity-checker');

let _lastBriefHour = -1;

async function runMorningBriefing() {
  const kstHour = kst.currentHour();
  if (!isBriefingTime(_lastBriefHour)) return;
  _lastBriefHour = kstHour;

  const items = await flushMorningQueue();
  if (items.length === 0) return;

  const brief = await buildMorningBriefingWithOps(items);
  if (brief) await sendTelegram(brief);
}

let _cleanupCounter = 0;

async function runCleanup() {
  _cleanupCounter += 1;
  if (_cleanupCounter % 60 !== 0) return;
  try {
    await cleanMutes();
    await cleanConfirms();
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
  } catch (error) {
    console.error(`[jay-runtime] cleanup error:`, error.message);
  }
}

let _identityCounter = 0;

async function runIdentityCheck() {
  try {
    const results = runCommanderIdentityCheck();
    const report = buildIdentityReport(results);
    if (report) {
      console.log(`[jay-runtime] commander identity issue detected -> Telegram report`);
      await sendTelegram(report);
    } else {
      console.log(`[jay-runtime] commander identity check OK`);
    }
  } catch (error) {
    console.error(`[jay-runtime] identity check error:`, error.message);
  }
}

async function mainLoop() {
  await runMorningBriefing();
  await runCleanup();

  _identityCounter += 1;
  if (_identityCounter % 10800 === 30) await runIdentityCheck();
}

async function main() {
  acquireLock();
  await flushPendingTelegrams();

  console.log(`🤖 ${BOT_NAME} runtime started (PID: ${process.pid}, lock: ${LOCK_PATH})`);

  while (true) {
    try {
      await mainLoop();
    } catch (error) {
      console.error(`[jay-runtime] loop error:`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(error => {
  console.error(`[jay-runtime] fatal error:`, error);
  process.exit(1);
});
