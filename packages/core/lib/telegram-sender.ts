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
const os = require('os');
const env = require('./env');
const hubAlarmClient = require('./hub-alarm-client');
const { publishToWebhook } = require('./reporting-hub');

type TeamKey =
  | 'general'
  | 'reservation'
  | 'ska'
  | 'investment'
  | 'luna'
  | 'claude'
  | 'claude-lead'
  | 'meeting'
  | 'emergency'
  | 'blog'
  | 'legal'
  | 'justin';

type TelegramTopicId = string | number;

type SecretPayload = {
  telegram_bot_token?: string;
  telegram_group_id?: string;
  telegram_chat_id?: string;
  telegram_topic_ids?: Record<string, TelegramTopicId>;
};

type HubSecretStore = {
  telegram?: {
    bot_token?: string;
    telegram_bot_token?: string;
    group_id?: string | number;
    telegram_group_id?: string | number;
    chat_id?: string | number;
    telegram_chat_id?: string | number;
    topic_ids?: Record<string, string | number | null | undefined>;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
  reservation?: {
    telegram_bot_token?: string;
    telegram_group_id?: string | number;
    telegram_chat_id?: string | number;
    telegram_topic_ids?: Record<string, string | number | null | undefined>;
  };
};

type SendOptions = {
  replyMarkup?: unknown;
  disableWebPagePreview?: boolean;
  chatId?: string;
  threadId?: TelegramTopicId | null;
};

type BatchEntry = {
  lines: string[];
  timer: NodeJS.Timeout | null;
  threadId: TelegramTopicId | null;
};

// ── 시크릿 로드 (lazy, 캐싱) ─────────────────────────────────────────
const SECRETS_PATH = path.join(__dirname, '../../../bots/reservation/secrets.json');
const HUB_SECRETS_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
let _cachedSecrets: SecretPayload | null = null;

function _normalizeTopicIds(raw: Record<string, string | number | null | undefined> | undefined): Record<string, TelegramTopicId> {
  const normalized: Record<string, TelegramTopicId> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value == null || value === '') continue;
    normalized[key] = typeof value === 'number' ? value : String(value);
  }
  return normalized;
}

function _normalizeHubTelegramSecrets(store: HubSecretStore): SecretPayload {
  const telegram = store?.telegram || {};
  const reservation = store?.reservation || {};
  return {
    telegram_bot_token: String(
      telegram.bot_token
      || telegram.telegram_bot_token
      || reservation.telegram_bot_token
      || '',
    ),
    telegram_group_id: String(
      telegram.group_id
      || telegram.telegram_group_id
      || reservation.telegram_group_id
      || '',
    ),
    telegram_chat_id: String(
      telegram.chat_id
      || telegram.telegram_chat_id
      || reservation.telegram_chat_id
      || '',
    ),
    telegram_topic_ids: {
      ..._normalizeTopicIds(reservation.telegram_topic_ids),
      ..._normalizeTopicIds(telegram.topic_ids || telegram.telegram_topic_ids),
    },
  };
}

function _secrets(): SecretPayload {
  if (!_cachedSecrets) {
    let legacySecrets: SecretPayload = {};
    let hubSecrets: SecretPayload = {};
    try { _cachedSecrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8')) as SecretPayload; }
    catch { legacySecrets = {}; }
    if (_cachedSecrets) legacySecrets = _cachedSecrets;

    try {
      hubSecrets = _normalizeHubTelegramSecrets(JSON.parse(fs.readFileSync(HUB_SECRETS_PATH, 'utf-8')) as HubSecretStore);
    } catch { hubSecrets = {}; }

    _cachedSecrets = {
      ...legacySecrets,
      ...hubSecrets,
      telegram_topic_ids: {
        ...(legacySecrets.telegram_topic_ids || {}),
        ...(hubSecrets.telegram_topic_ids || {}),
      },
    };
  }
  return _cachedSecrets;
}

const _token  = () => process.env.TELEGRAM_BOT_TOKEN || _secrets().telegram_bot_token || '';
// Forum Topic 발송용 chat_id: TELEGRAM_CHAT_ID는 개인 fallback으로 쓰이는 경우가 많다.
// topic-enabled send는 반드시 그룹 ID를 먼저 잡아야 message_thread_id가 적용된다.
const _chatId = () => process.env.TELEGRAM_GROUP_ID || _secrets().telegram_group_id || process.env.TELEGRAM_CHAT_ID || _secrets().telegram_chat_id || '';
const _topics = () => _secrets().telegram_topic_ids || {};

function _alertsDisabled(): boolean {
  const raw = String(
    process.env.TELEGRAM_ALERTS_DISABLED
    || process.env.HUB_ALARMS_DISABLED
    || process.env.ALERTS_DISABLED
    || ''
  ).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

// ── Team → secrets.json 키 매핑 ──────────────────────────────────────
// telegram_topic_ids.{ general, ska, luna, claude_lead, meeting, emergency, legal }
const TOPIC_KEYS = {
  'general':     'general',
  'reservation': 'ska',
  'ska':         'ska',
  'investment':  'luna',
  'luna':        'luna',
  'claude':      'claude_lead',
  'claude-lead': 'claude_lead',
  'meeting':     'meeting',
  'emergency':   'emergency',
  'blog':        'blog',
  'legal':       'legal',
  'justin':      'legal',
};

function _getThreadId(team: string): TelegramTopicId | null {
  const key = TOPIC_KEYS[team as TeamKey] ?? 'general';
  const ids = _topics();
  return ids[key] ?? ids['general'] ?? null;
}

// ── Pending Queue ─────────────────────────────────────────────────────
const RUNTIME_ROOT = process.env.HUB_RUNTIME_DIR
  || process.env.JAY_RUNTIME_DIR
  || path.join(os.homedir(), '.ai-agent-system', 'hub');
const WORKSPACE    = path.join(RUNTIME_ROOT, 'telegram');
const PENDING_FILE = path.join(WORKSPACE, 'pending-telegrams.jsonl');
const LEGACY_WORKSPACE = process.env.OPENCLAW_WORKSPACE || '';
const LEGACY_PENDING_FILE = LEGACY_WORKSPACE
  ? path.join(LEGACY_WORKSPACE, 'pending-telegrams.jsonl')
  : '';
const TG_MAX       = 4096 - 20;  // Telegram 최대 길이 여유 확보
const MOBILE_DIVIDER = '──────────';

function _normalizeForMobile(message: string): string {
  const raw = String(message || '');
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .map((line) => {
      const trimmed = line.trim();
      if (/^[━═─-]{8,}$/.test(trimmed)) return MOBILE_DIVIDER;
      return line;
    });

  const compact = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && previousBlank) continue;
    compact.push(line);
    previousBlank = blank;
  }

  return compact.join('\n').trim();
}

const PENDING_MAX_AGE_MS = 30 * 60 * 1000;  // 30분 초과 메시지 폐기
const PENDING_MAX_RETRIES = 3;              // 최대 재시도 3회
const PENDING_MAX_QUEUE = 50;               // 큐 최대 50건

function _savePending(team: string, message: string): void {
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    // 큐 크기 제한
    if (fs.existsSync(PENDING_FILE)) {
      const lines = fs.readFileSync(PENDING_FILE, 'utf-8').split('\n').filter(Boolean);
      if (lines.length >= PENDING_MAX_QUEUE) {
        console.warn(`⚠️ [telegram-sender] 대기큐 한도 초과 (${lines.length}건) — 신규 메시지 폐기`);
        return;
      }
    }
    const entry = JSON.stringify({ team, message, savedAt: new Date().toISOString(), retries: 0 });
    fs.appendFileSync(PENDING_FILE, entry + '\n', 'utf-8');
  } catch { /* 유실보다 무시가 낫다 */ }
}

function _migrateLegacyPendingQueue(): void {
  try {
    if (!LEGACY_PENDING_FILE) return;
    if (!fs.existsSync(LEGACY_PENDING_FILE)) return;
    if (path.resolve(LEGACY_PENDING_FILE) === path.resolve(PENDING_FILE)) return;

    fs.mkdirSync(WORKSPACE, { recursive: true });
    if (!fs.existsSync(PENDING_FILE)) {
      fs.renameSync(LEGACY_PENDING_FILE, PENDING_FILE);
      return;
    }

    const legacyLines = fs.readFileSync(LEGACY_PENDING_FILE, 'utf-8');
    if (legacyLines.trim()) {
      const current = fs.readFileSync(PENDING_FILE, 'utf-8');
      const merged = current.endsWith('\n') || current.length === 0
        ? `${current}${legacyLines}`
        : `${current}\n${legacyLines}`;
      fs.writeFileSync(PENDING_FILE, merged, 'utf-8');
    }
    fs.unlinkSync(LEGACY_PENDING_FILE);
  } catch (error: any) {
    console.warn(`⚠️ [telegram-sender] legacy pending queue migration 실패: ${error?.message || error}`);
  }
}

// ── 파일명 누출 방어 (BUG-006) ────────────────────────────────────────
const FILE_PATTERN = /^[\w\-. ]+\.(md|js|json|txt|sh|py|plist|log|db)$/i;

function _isFilenameLeak(msg: string): boolean {
  const t = msg.trim();
  if (!t.includes('\n') && FILE_PATTERN.test(t)) return true;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length >= 1 && lines.every(l => FILE_PATTERN.test(l));
}

// ── 긴급 메시지 판별 ──────────────────────────────────────────────────
function _isUrgent(message: string): boolean {
  return message.includes('🚨') || message.toUpperCase().includes('CRITICAL');
}

// ── Throttle 설정 ─────────────────────────────────────────────────────
const MIN_INTERVAL_MS = 1500;  // 텔레그램 초당 제한 대응 (최대 ~30msg/sec, 여유 확보)
let _lastSentAt = 0;
let _lastSendError = '';

function _setLastSendError(message: string): void {
  _lastSendError = String(message || '').slice(0, 400);
}

export function getLastTelegramSendError(): string {
  return _lastSendError;
}

// ── 배치 설정 ─────────────────────────────────────────────────────────
const BATCH_WINDOW_MS = 2000;  // 동일 팀 메시지를 2초 내 합치기
// topic → { lines: string[], timer: NodeJS.Timeout|null, threadId: number|null }
const _batchBuffer = new Map<string, BatchEntry>();

// ── 단일 발송 시도 (Rate Limit 정보 포함) ────────────────────────────
/**
 * @returns {{ ok: boolean, code: number, retryAfter: number }}
 */
async function _trySend(text: string, threadId: TelegramTopicId | null, options: SendOptions = {}) {
  const token  = _token();
  const chatId = options.chatId || _chatId();
  _setLastSendError('');
  if (!token || !chatId) {
    _setLastSendError('telegram_credentials_missing');
    return { ok: false, code: 0, retryAfter: 0 };
  }

  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (threadId) body.message_thread_id = threadId;
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  if (typeof options.disableWebPagePreview === 'boolean') {
    body.disable_web_page_preview = options.disableWebPagePreview;
  }

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
    _setLastSendError(data.description || data.error_code || `telegram_api_error_${code}`);
    return { ok: false, code, retryAfter };
  } catch (error: any) {
    _setLastSendError(error?.message || 'telegram_fetch_failed');
    return { ok: false, code: 0, retryAfter: 0 };
  }
}

// ── Throttle + Rate Limit 처리 통합 발송 ────────────────────────────
/**
 * Throttle(MIN_INTERVAL_MS) 적용 후 _trySend 호출.
 * 429 발생 시 retry_after 준수, 기타 실패 시 3초 간격 재시도.
 * @returns {Promise<boolean>}
 */
async function _doSend(text: string, threadId: TelegramTopicId | null, options: SendOptions = {}): Promise<boolean> {
  // Throttle: 마지막 발송으로부터 MIN_INTERVAL_MS 확보
  const now  = Date.now();
  const wait = _lastSentAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const MAX_TRIES = 3;
  for (let i = 1; i <= MAX_TRIES; i++) {
    _lastSentAt = Date.now();
    const { ok, code, retryAfter } = await _trySend(text, threadId, options);
    if (ok) return true;

    if (
      code === 400
      && threadId != null
      && /message thread not found/i.test(_lastSendError)
    ) {
      console.warn(`⚠️ [telegram-sender] topic id 무효 — 그룹 루트로 재시도 (thread=${threadId})`);
      const retryWithoutThread = await _trySend(text, null, options);
      if (retryWithoutThread.ok) return true;
    }

    if (code === 429 && retryAfter > 0) {
      console.warn(`⚠️ [telegram-sender] Rate Limit (429) — ${retryAfter}초 대기 후 재시도 (${i}/${MAX_TRIES})`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    } else if (i < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  return false;
}

// ── 배치 flush ────────────────────────────────────────────────────────
async function _flushBatch(topic: string): Promise<void> {
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
export async function send(team: string, message: string): Promise<boolean> {
  if (_alertsDisabled()) return true;
  const normalized = _normalizeForMobile(message);

  if (_isFilenameLeak(normalized)) {
    console.warn(`🚫 [telegram-sender] 파일명 누출 차단 (team=${team}): ${normalized.slice(0, 60)}`);
    return false;
  }

  if (env.IS_OPS) {
    const result = await publishToWebhook({
      event: {
        from_bot: 'telegram-sender',
        team,
        event_type: 'telegram_send',
        alert_level: _isUrgent(normalized) ? 4 : 2,
        message: normalized,
      },
    });
    return Boolean(result?.ok);
  }

  const threadId = _getThreadId(team);

  // 긴급 메시지: 배치 우회, 즉시 발송
  if (_isUrgent(normalized)) {
    const text = normalized.slice(0, TG_MAX);
    if (await _doSend(text, threadId)) return true;
    console.warn(`⚠️ [telegram-sender] 긴급 메시지 발송 최종 실패 — 대기큐 저장 (team=${team})`);
    _savePending(team, normalized);
    return false;
  }

  // 일반 메시지: 배치 버퍼에 추가
  let buf = _batchBuffer.get(team);
  if (!buf) {
    buf = { lines: [], timer: null, threadId };
    _batchBuffer.set(team, buf);
  }

  buf.lines.push(normalized.slice(0, TG_MAX));

  // 타이머 리셋 (2초 배치 윈도우)
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => _flushBatch(team), BATCH_WINDOW_MS);

  return true;  // 배치 버퍼 추가 성공
}

/**
 * Hub /hub/alarm 전용 직접 발송 경로.
 *
 * OPS 모드의 일반 send()는 reporting-hub → postAlarm()을 거치므로 Hub alarm route에서
 * 호출하면 재귀가 생긴다. 이 함수는 Hub가 canonical alarm transport가 된 뒤에도
 * OpenClaw fallback 없이 Telegram topic으로 바로 전달하기 위한 escape hatch다.
 */
export async function sendFromHubAlarm(team: string, message: string, options: SendOptions = {}): Promise<boolean> {
  if (_alertsDisabled()) return false;
  const normalized = _normalizeForMobile(message);

  if (_isFilenameLeak(normalized)) {
    console.warn(`🚫 [telegram-sender] Hub alarm 파일명 누출 차단 (team=${team}): ${normalized.slice(0, 60)}`);
    return false;
  }

  const threadId = options.threadId ?? _getThreadId(team);
  const text = normalized.slice(0, TG_MAX);
  const ok = await _doSend(text, threadId, options);
  if (ok) return true;
  console.warn(`⚠️ [telegram-sender] Hub alarm 직접 발송 실패 — 대기큐 저장 (team=${team})`);
  _savePending(team, normalized);
  return false;
}

async function sendBuffered(team: string, message: string): Promise<boolean> {
  if (_alertsDisabled()) return true;
  const normalized = _normalizeForMobile(message);

  if (_isFilenameLeak(normalized)) {
    console.warn(`🚫 [telegram-sender] 파일명 누출 차단 (team=${team}): ${normalized.slice(0, 60)}`);
    return false;
  }

  if (env.IS_OPS) {
    const result = await publishToWebhook({
      event: {
        from_bot: 'telegram-sender',
        team,
        event_type: 'telegram_buffered_send',
        alert_level: _isUrgent(normalized) ? 4 : 2,
        message: normalized,
      },
    });
    return Boolean(result?.ok);
  }

  const threadId = _getThreadId(team);
  const text = normalized.slice(0, TG_MAX);
  const ok = await _doSend(text, threadId);
  if (ok) return true;
  console.warn(`⚠️ [telegram-sender] 배치 발송 최종 실패 — 대기큐 저장 (topic=${team})`);
  _savePending(team, normalized);
  return false;
}

async function sendWithOptions(team: string, message: string, options: SendOptions = {}): Promise<boolean> {
  if (_alertsDisabled()) return true;
  const normalized = _normalizeForMobile(message);

  if (_isFilenameLeak(normalized)) {
    console.warn(`🚫 [telegram-sender] 파일명 누출 차단 (team=${team}): ${normalized.slice(0, 60)}`);
    return false;
  }

  if (env.IS_OPS) {
    const result = await publishToWebhook({
      event: {
        from_bot: 'telegram-sender',
        team,
        event_type: 'telegram_option_send',
        alert_level: _isUrgent(normalized) ? 4 : 2,
        message: normalized,
      },
    });
    return Boolean(result?.ok);
  }

  const threadId = _getThreadId(team);
  const text = normalized.slice(0, TG_MAX);
  const ok = await _doSend(text, threadId, options);
  if (ok) return true;
  console.warn(`⚠️ [telegram-sender] 옵션 메시지 발송 최종 실패 — 대기큐 저장 (team=${team})`);
  _savePending(team, normalized);
  return false;
}

async function sendDirect(chatId: string, message: string, options: SendOptions = {}): Promise<boolean> {
  if (_alertsDisabled()) return true;
  if (!chatId) return false;
  const normalized = _normalizeForMobile(message);

  if (_isFilenameLeak(normalized)) {
    console.warn(`🚫 [telegram-sender] 파일명 누출 차단 (chat=${chatId}): ${normalized.slice(0, 60)}`);
    return false;
  }

  if (env.IS_OPS) {
    console.warn('[telegram-sender] sendDirect는 OPS에서 비활성화됨 — OpenClaw topic 라우팅 사용');
    return false;
  }

  const text = normalized.slice(0, TG_MAX);
  const ok = await _doSend(text, options.threadId || null, {
    ...options,
    chatId,
  });
  return ok;
}

/**
 * CRITICAL 알림 — 🚨 긴급 Topic + 해당 팀 Topic 이중 발송
 * @param {string} team    발신 팀
 * @param {string} message CRITICAL 메시지
 */
export async function sendCritical(team: string, message: string): Promise<boolean> {
  if (env.IS_OPS) {
    const full = `🚨 CRITICAL\n${message}`;
    const tasks = [publishToWebhook({
      event: {
        from_bot: 'telegram-sender',
        team: 'emergency',
        event_type: 'telegram_critical',
        alert_level: 4,
        message: `🚨 [${team}] CRITICAL\n${message}`,
      },
    })];
    if (team !== 'emergency') {
      tasks.push(publishToWebhook({
        event: {
          from_bot: 'telegram-sender',
          team,
          event_type: 'telegram_critical',
          alert_level: 4,
          message: full,
        },
      }));
    }
    const results = await Promise.all(tasks);
    return results.every((result) => Boolean(result?.ok));
  }

  const full = `🚨 [${team}] CRITICAL\n${message}`;
  const tasks = [send('emergency', full)];
  if (team !== 'emergency') tasks.push(send(team, `🚨 CRITICAL\n${message}`));
  const results = await Promise.all(tasks);
  return results.every(Boolean);
}

export async function sendCriticalFromHubAlarm(team: string, message: string): Promise<boolean> {
  const full = `🚨 [${team}] CRITICAL\n${message}`;
  const tasks = [sendFromHubAlarm('emergency', full)];
  if (team !== 'emergency') tasks.push(sendFromHubAlarm(team, `🚨 CRITICAL\n${message}`));
  const results = await Promise.all(tasks);
  return results.every(Boolean);
}

/**
 * 대기큐 재발송 (재시작 시 호출)
 * 구형 포맷 { message, chatId } 와 신형 포맷 { team, message } 모두 처리.
 */
export async function flushPending() {
  _migrateLegacyPendingQueue();
  if (!fs.existsSync(PENDING_FILE)) return;

  let lines: string[];
  try { lines = fs.readFileSync(PENDING_FILE, 'utf-8').split('\n').filter((l: string) => l.trim()); }
  catch { return; }
  if (!lines.length) return;

  console.log(`📤 [telegram-sender] 대기큐 재발송 시작: ${lines.length}건`);

  const now = Date.now();
  const remaining = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }  // 손상 줄 폐기

    if (entry.message?.length > TG_MAX) continue;  // 영구 실패 → 폐기

    // TTL: 30분 초과 메시지 폐기
    const savedAt = entry.savedAt ? new Date(entry.savedAt).getTime() : 0;
    if (savedAt > 0 && (now - savedAt) > PENDING_MAX_AGE_MS) continue;

    // 재시도 횟수 초과 → 폐기
    const retries = (entry.retries || 0) + 1;
    if (retries > PENDING_MAX_RETRIES) continue;

    // 신형(team) / 구형(chatId) 포맷 모두 지원
    const team = entry.team || 'general';
    const ok = env.IS_OPS
      ? await send(team, entry.message)
      : await _doSend(entry.message, entry.threadId ?? _getThreadId(team));
    if (!ok) {
      entry.retries = retries;
      remaining.push(JSON.stringify(entry));
    }
  }

  try {
    if (!remaining.length) fs.unlinkSync(PENDING_FILE);
    else fs.writeFileSync(PENDING_FILE, remaining.join('\n') + '\n', 'utf-8');
  } catch { /* 무시 */ }
}

export function _testOnly_getPendingQueuePaths(): {
  runtimeRoot: string;
  workspace: string;
  pendingFile: string;
  legacyWorkspace: string;
  legacyPendingFile: string;
} {
  return {
    runtimeRoot: RUNTIME_ROOT,
    workspace: WORKSPACE,
    pendingFile: PENDING_FILE,
    legacyWorkspace: LEGACY_WORKSPACE,
    legacyPendingFile: LEGACY_PENDING_FILE,
  };
}
