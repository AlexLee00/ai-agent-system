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
// Forum Topic 발송용 chat_id: 그룹 ID 우선, 없으면 개인 chat_id 폴백
const _chatId = () => _secrets().telegram_group_id  || _secrets().telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '';
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
  'blog':        'blog',
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

// ── 긴급 메시지 판별 ──────────────────────────────────────────────────
function _isUrgent(message) {
  return message.includes('🚨') || message.toUpperCase().includes('CRITICAL');
}

// ── Throttle 설정 ─────────────────────────────────────────────────────
const MIN_INTERVAL_MS = 1500;  // 텔레그램 초당 제한 대응 (최대 ~30msg/sec, 여유 확보)
let _lastSentAt = 0;

// ── 배치 설정 ─────────────────────────────────────────────────────────
const BATCH_WINDOW_MS = 2000;  // 동일 팀 메시지를 2초 내 합치기
// topic → { lines: string[], timer: NodeJS.Timeout|null, threadId: number|null }
const _batchBuffer = new Map();

// ── 단일 발송 시도 (Rate Limit 정보 포함) ────────────────────────────
/**
 * @returns {{ ok: boolean, code: number, retryAfter: number }}
 */
async function _trySend(text, threadId) {
  const token  = _token();
  const chatId = _chatId();
  if (!token || !chatId) return { ok: false, code: 0, retryAfter: 0 };

  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (threadId) body.message_thread_id = threadId;

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10000),
    });
    const code = res.status;
    const data = await res.json();

    if (data.ok === true) return { ok: true, code, retryAfter: 0 };

    // 429: Rate Limit — retry_after(초) 준수
    const retryAfter = code === 429 ? (data.parameters?.retry_after ?? 5) : 0;
    return { ok: false, code, retryAfter };
  } catch {
    return { ok: false, code: 0, retryAfter: 0 };
  }
}

// ── Throttle + Rate Limit 처리 통합 발송 ────────────────────────────
/**
 * Throttle(MIN_INTERVAL_MS) 적용 후 _trySend 호출.
 * 429 발생 시 retry_after 준수, 기타 실패 시 3초 간격 재시도.
 * @returns {Promise<boolean>}
 */
async function _doSend(text, threadId) {
  // Throttle: 마지막 발송으로부터 MIN_INTERVAL_MS 확보
  const now  = Date.now();
  const wait = _lastSentAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    _lastSentAt = Date.now();
    const { ok, code, retryAfter } = await _trySend(text, threadId);
    if (ok) return true;

    if (code === 429 && retryAfter > 0) {
      console.warn(`⚠️ [telegram-sender] Rate Limit (429) — ${retryAfter}초 대기 후 재시도 (${i}/${MAX_TRIES})`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    } else if (i < MAX_TRIES) {
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
  return false;
}

// ── 배치 flush ────────────────────────────────────────────────────────
async function _flushBatch(topic) {
  const buf = _batchBuffer.get(topic);
  if (!buf || buf.lines.length === 0) {
    _batchBuffer.delete(topic);
    return;
  }
  _batchBuffer.delete(topic);

  // 전체 텍스트가 TG_MAX 초과 시 앞에서 자름
  const full = buf.lines.join('\n\n');
  const text = full.length > TG_MAX ? full.slice(-TG_MAX) : full;

  if (await _doSend(text, buf.threadId)) return;

  console.warn(`⚠️ [telegram-sender] 배치 발송 최종 실패 — 대기큐 저장 (topic=${topic})`);
  for (const line of buf.lines) _savePending(topic, line);
}

// ── 팀별 발송 ─────────────────────────────────────────────────────────

/**
 * 팀별 텔레그램 발송
 * - 긴급(🚨/CRITICAL): 즉시 발송 (배치 우회)
 * - 일반: 2초 배치 윈도우 내 동일 팀 메시지 합산 후 발송
 *
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

  // 긴급 메시지: 배치 우회, 즉시 발송
  if (_isUrgent(message)) {
    const text = message.slice(0, TG_MAX);
    if (await _doSend(text, threadId)) return true;
    console.warn(`⚠️ [telegram-sender] 긴급 메시지 발송 최종 실패 — 대기큐 저장 (team=${team})`);
    _savePending(team, message);
    return false;
  }

  // 일반 메시지: 배치 버퍼에 추가
  let buf = _batchBuffer.get(team);
  if (!buf) {
    buf = { lines: [], timer: null, threadId };
    _batchBuffer.set(team, buf);
  }

  buf.lines.push(message.slice(0, TG_MAX));

  // 타이머 리셋 (2초 배치 윈도우)
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => _flushBatch(team), BATCH_WINDOW_MS);

  return true;  // 배치 버퍼 추가 성공
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
    const ok       = await _doSend(entry.message, threadId);  // Rate Limit 처리 포함
    if (!ok) remaining.push(line);
  }

  try {
    if (!remaining.length) fs.unlinkSync(PENDING_FILE);
    else fs.writeFileSync(PENDING_FILE, remaining.join('\n') + '\n', 'utf-8');
  } catch { /* 무시 */ }
}

module.exports = { send, sendCritical, flushPending };
