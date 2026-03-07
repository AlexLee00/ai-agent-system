'use strict';

/**
 * packages/core/lib/telegram-sender.js — 공용 텔레그램 발송 (Forum Topic 라우팅)
 *
 * 전 팀이 이 모듈 하나로 텔레그램 발송.
 * Forum Topic이 설정되어 있으면 message_thread_id로 팀별 채널에 라우팅.
 * 미설정이면 기존처럼 단일 채팅에 발송 (하위 호환).
 *
 * Topic 구성 (setup-telegram-forum.js 실행 후 secrets.json에 저장):
 *   📌 일반       → general
 *   🏢 스카       → ska
 *   💰 루나       → luna
 *   🔧 클로드     → claude_lead
 *   📊 팀장 회의록 → meeting
 *   🚨 긴급       → emergency
 *
 * 사용법 (CJS):
 *   const sender = require('packages/core/lib/telegram-sender');
 *   await sender.send('ska', '메시지');
 *   await sender.sendCritical('luna', '긴급 메시지');
 *
 * 사용법 (ESM):
 *   import { createRequire } from 'module';
 *   const require = createRequire(import.meta.url);
 *   const sender = require('packages/core/lib/telegram-sender');
 */

const fs   = require('fs');
const path = require('path');

// ── 시크릿 로드 (lazy, 캐싱) ─────────────────────────────────────────
const SECRETS_PATH = path.join(__dirname, '../../../bots/reservation/secrets.json');
let _cachedSecrets = null;

function _secrets() {
  if (!_cachedSecrets) {
    try { _cachedSecrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8')); }
    catch { _cachedSecrets = {}; }
  }
  return _cachedSecrets;
}

const _token  = () => _secrets().telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
const _chatId = () => _secrets().telegram_chat_id   || process.env.TELEGRAM_CHAT_ID   || '';
const _topics = () => _secrets().telegram_topic_ids || {};

// ── Team → secrets.json 키 매핑 ──────────────────────────────────────
// telegram_topic_ids.{ general, ska, luna, claude_lead, meeting, emergency }
const TOPIC_KEYS = {
  'general':     'general',
  'ska':         'ska',
  'luna':        'luna',
  'claude-lead': 'claude_lead',
  'meeting':     'meeting',
  'emergency':   'emergency',
};

function _getThreadId(team) {
  const key = TOPIC_KEYS[team] ?? 'general';
  const ids = _topics();
  return ids[key] ?? ids['general'] ?? null;
}

// ── Pending Queue ─────────────────────────────────────────────────────
const WORKSPACE    = path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace');
const PENDING_FILE = path.join(WORKSPACE, 'pending-telegrams.jsonl');
const TG_MAX       = 4096 - 20;  // Telegram 최대 길이 여유 확보

function _savePending(team, message) {
  try {
    if (!fs.existsSync(WORKSPACE)) return;
    const entry = JSON.stringify({ team, message, savedAt: new Date().toISOString() });
    fs.appendFileSync(PENDING_FILE, entry + '\n', 'utf-8');
  } catch { /* 유실보다 무시가 낫다 */ }
}

// ── 파일명 누출 방어 (BUG-006) ────────────────────────────────────────
const FILE_PATTERN = /^[\w\-. ]+\.(md|js|json|txt|sh|py|plist|log|db)$/i;

function _isFilenameLeak(msg) {
  const t = msg.trim();
  if (!t.includes('\n') && FILE_PATTERN.test(t)) return true;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length >= 1 && lines.every(l => FILE_PATTERN.test(l));
}

// ── 단일 발송 시도 ─────────────────────────────────────────────────────
async function _trySend(text, threadId) {
  const token  = _token();
  const chatId = _chatId();
  if (!token || !chatId) return false;

  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (threadId) body.message_thread_id = threadId;

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.ok === true;
  } catch { return false; }
}

// ── 팀별 발송 ─────────────────────────────────────────────────────────

/**
 * 팀별 텔레그램 발송 — 3회 재시도 + 실패 시 pending 큐 저장
 * @param {string} team    'ska'|'luna'|'claude-lead'|'general'|'meeting'|'emergency'
 * @param {string} message 발송 메시지 (HTML 태그 사용 가능)
 * @returns {Promise<boolean>}
 */
async function send(team, message) {
  if (process.env.TELEGRAM_ENABLED === '0') return true;

  if (_isFilenameLeak(message)) {
    console.warn(`🚫 [telegram-sender] 파일명 누출 차단 (team=${team}): ${message.slice(0, 60)}`);
    return false;
  }

  const threadId = _getThreadId(team);

  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    if (await _trySend(message, threadId)) return true;
    if (i < MAX_TRIES) await new Promise(r => setTimeout(r, i * 3000));
  }

  console.warn(`⚠️ [telegram-sender] 발송 최종 실패 — 대기큐 저장 (team=${team})`);
  _savePending(team, message);
  return false;
}

/**
 * CRITICAL 알림 — 🚨 긴급 Topic + 해당 팀 Topic 이중 발송
 * @param {string} team    발신 팀
 * @param {string} message CRITICAL 메시지
 */
async function sendCritical(team, message) {
  const full = `🚨 [${team}] CRITICAL\n${message}`;
  const tasks = [send('emergency', full)];
  if (team !== 'emergency') tasks.push(send(team, `🚨 CRITICAL\n${message}`));
  await Promise.all(tasks);
}

/**
 * 대기큐 재발송 (재시작 시 호출)
 * 구형 포맷 { message, chatId } 와 신형 포맷 { team, message } 모두 처리.
 */
async function flushPending() {
  if (!fs.existsSync(PENDING_FILE)) return;

  let lines;
  try { lines = fs.readFileSync(PENDING_FILE, 'utf-8').split('\n').filter(l => l.trim()); }
  catch { return; }
  if (!lines.length) return;

  console.log(`📤 [telegram-sender] 대기큐 재발송 시작: ${lines.length}건`);

  const remaining = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }  // 손상 줄 폐기

    if (entry.message?.length > TG_MAX) continue;  // 영구 실패 → 폐기

    // 신형(team) / 구형(chatId) 포맷 모두 지원
    const team     = entry.team || 'general';
    const threadId = entry.threadId ?? _getThreadId(team);
    const ok       = await _trySend(entry.message, threadId);
    if (!ok) remaining.push(line);
  }

  try {
    if (!remaining.length) fs.unlinkSync(PENDING_FILE);
    else fs.writeFileSync(PENDING_FILE, remaining.join('\n') + '\n', 'utf-8');
  } catch { /* 무시 */ }
}

module.exports = { send, sendCritical, flushPending };
