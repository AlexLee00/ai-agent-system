/**
 * packages/core/lib/hub-alarm-client.js — Hub alarm 클라이언트
 *
 * 모든 봇 알람을 Hub /hub/alarm으로 우선 전달한다.
 * legacy OpenClaw webhook은 HUB_ALARM_LEGACY_OPENCLAW_FALLBACK=true일 때만 사용한다.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const env = require('./env.legacy.js');
const { fetchHubSecrets } = require('./hub-client.legacy.js');

const HOOK_URL = 'http://127.0.0.1:18789/hooks/agent';
const TIMEOUT_MS = 30_000;
const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 5000) || 5000);
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const TELEGRAM_RETRY_ATTEMPTS = 2;
const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()
  || path.join(env.OPENCLAW_WORKSPACE, 'recent-alerts.json');
const RECENT_ALERT_LIMIT = 50;

const TEAM_TOPIC = {
  general: 'general',
  reservation: 'ska',
  ska: 'ska',
  investment: 'luna',
  luna: 'luna',
  claude: 'claude_lead',
  'claude-lead': 'claude_lead',
  blog: 'blog',
  worker: 'worker',
  video: 'video',
  darwin: 'darwin',
  justin: 'justin',
  sigma: 'sigma',
  meeting: 'meeting',
  emergency: 'emergency',
};

type TopicIdMap = Record<string, string>;

type HubAlarmStore = {
  openclaw?: {
    hooks_token?: string;
  };
  telegram?: {
    group_id?: string;
    topic_ids?: TopicIdMap;
    bot_token?: string;
    darwin_bot_token?: string;
  };
  darwin?: {
    telegram_bot_token?: string;
  };
};

type SecretTopicInfo = {
  group_id?: string;
  topic_ids?: TopicIdMap;
};

type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

type InlineKeyboard = TelegramInlineButton[][];

type PostAlarmInput = {
  message: string;
  team?: string;
  alertLevel?: number;
  fromBot?: string;
  sessionKey?: string;
  payload?: unknown;
  criticalTelegramMode?: string;
  inlineKeyboard?: InlineKeyboard | null;
};

type InlineTelegramInput = {
  message: string;
  team: string;
  fromBot: string;
  topicId: string | null;
  groupId: string;
  inlineKeyboard: InlineKeyboard;
};

type ExecError = Error & {
  status?: number;
};

type RecentAlertSnapshotRow = {
  from_bot: string;
  team: string;
  event_type: string | null;
  alert_level: number;
  message: string;
  status: string;
  created_at: string;
};

let _token: string | null = null;
let _groupId: string | null = null;
let _topicIds: TopicIdMap | null = null;
let _telegramBotToken: string | null = null;
let _darwinTelegramBotToken: string | null = null;

function _normalizeAlertText(value: unknown): string {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (['undefined', 'null', 'nan', '[object object]'].includes(lowered)) return '';
  return text;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _resolveTelegramRetryDelayMs(res: Response | null, body: any, fallbackMs = 3000): number {
  const retryAfterSec = Number(body?.parameters?.retry_after || res?.headers?.get('retry-after') || 0);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.max(1000, retryAfterSec * 1000);
  }
  return fallbackMs;
}

function _readBooleanEnv(...names: string[]): boolean {
  for (const name of names) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) continue;
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  return false;
}

function _readStoreToken() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as HubAlarmStore;
    return store?.openclaw?.hooks_token || '';
  } catch {
    return '';
  }
}

function _readStoreTopicInfo() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as HubAlarmStore;
    return {
      groupId: store?.telegram?.group_id || '',
      topicIds: store?.telegram?.topic_ids || {},
    };
  } catch {
    return { groupId: '', topicIds: {} };
  }
}

async function _getToken(): Promise<string> {
  if (_token) return _token;

  const hubData = await fetchHubSecrets('openclaw') as { hooks_token?: string } | null;
  _token = hubData?.hooks_token
    || process.env.HUB_ALARM_LEGACY_OPENCLAW_HOOKS_TOKEN
    || process.env.OPENCLAW_HOOKS_TOKEN
    || _readStoreToken()
    || '';
  return _token;
}

async function _getTopicInfo(): Promise<{ groupId: string; topicIds: TopicIdMap }> {
  if (_groupId && _topicIds) {
    return { groupId: _groupId, topicIds: _topicIds };
  }

  const hubData = await fetchHubSecrets('telegram') as SecretTopicInfo | null;
  const storeData = _readStoreTopicInfo();

  _groupId = hubData?.group_id
    || process.env.TELEGRAM_GROUP_ID
    || storeData.groupId
    || '';
  _topicIds = hubData?.topic_ids
    || storeData.topicIds
    || {};

  return { groupId: _groupId, topicIds: _topicIds };
}

async function _getTelegramBotToken(): Promise<string> {
  if (_telegramBotToken) return _telegramBotToken;

  const telegramData = await fetchHubSecrets('telegram') as { bot_token?: string } | null;
  const reservationData = await fetchHubSecrets('reservation-shared') as { telegram_bot_token?: string } | null;

  _telegramBotToken = telegramData?.bot_token
    || reservationData?.telegram_bot_token
    || '';
  return _telegramBotToken;
}

async function _getDarwinTelegramBotToken(): Promise<string> {
  if (_darwinTelegramBotToken) return _darwinTelegramBotToken;

  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as HubAlarmStore;
    _darwinTelegramBotToken = store?.darwin?.telegram_bot_token
      || store?.telegram?.darwin_bot_token
      || process.env.DARWIN_TELEGRAM_BOT_TOKEN
      || '';
  } catch {
    _darwinTelegramBotToken = process.env.DARWIN_TELEGRAM_BOT_TOKEN || '';
  }

  return _darwinTelegramBotToken;
}

function _postHookViaCurl({ token, payload }: { token: string; payload: Record<string, unknown> }) {
  try {
    const result = spawnSync('curl', [
      '-sS',
      '-X', 'POST',
      HOOK_URL,
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${token}`,
      '--data', JSON.stringify(payload),
    ], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    }) as { error?: Error; status?: number; stderr?: string; stdout?: string };

    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      return { ok: false, error: result.stderr?.trim() || `curl_exit_${result.status}` };
    }

    const body = JSON.parse(result.stdout || '{}');
    return { ok: body?.ok === true, status: 200, body };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function _extractEventType(message: string, payload: unknown): string | null {
  const payloadEventType = (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).event_type === 'string'
  )
    ? String((payload as Record<string, unknown>).event_type || '').trim()
    : '';
  if (payloadEventType) {
    return payloadEventType;
  }

  const match = String(message || '').match(/(?:^|\n)\s*event_type\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

function _mapAlertLevelToSeverity(level: number): 'info' | 'warn' | 'error' | 'critical' {
  if (level >= 4) return 'critical';
  if (level === 3) return 'error';
  if (level === 2) return 'warn';
  return 'info';
}

function _isHubAlarmDeliveryAccepted(response: Response, body: any): boolean {
  if (!response.ok || body?.ok !== true) return false;
  if (body?.suppressed === true || body?.reason === 'alerts_disabled') return false;
  if (body?.deduped === true) return true;
  if (
    body?.governed === true
    && ['internal', 'audit_only', 'digest'].includes(String(body?.visibility || '').toLowerCase())
  ) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'delivered')) {
    return body?.delivered === true;
  }
  return true;
}

function _isLegacyOpenClawFallbackEnabled(): boolean {
  return _readBooleanEnv('HUB_ALARM_LEGACY_OPENCLAW_FALLBACK', 'OPENCLAW_LEGACY_FALLBACK');
}

async function _postAlarmViaHub({
  message,
  team,
  alertLevel,
  fromBot,
  payload,
}: {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  payload: unknown;
}) {
  const hubBaseUrl = String(env.HUB_BASE_URL || '').trim().replace(/\/+$/, '');
  const hubToken = String(env.HUB_AUTH_TOKEN || '').trim();
  if (!hubBaseUrl || !hubToken) {
    return { ok: false, skipped: true, error: 'hub_alarm_auth_missing' };
  }
  const url = `${hubBaseUrl}/hub/alarm`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({
        message,
        team,
        fromBot,
        severity: _mapAlertLevelToSeverity(alertLevel),
        title: `${team} alarm`,
        payload,
      }),
      signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    const accepted = _isHubAlarmDeliveryAccepted(response, body);
    const error = !accepted
      ? (body?.reason || body?.delivery_error || body?.error || 'hub_alarm_not_delivered')
      : null;
    return {
      ok: accepted,
      status: response.status,
      body,
      source: 'hub_alarm',
      error: response.ok ? error : (body?.error || `hub_alarm_http_${response.status}`),
    };
  } catch (error) {
    const err = error as ExecError;
    return { ok: false, source: 'hub_alarm', error: err.message };
  }
}

function _readRecentAlertSnapshot(): RecentAlertSnapshotRow[] {
  try {
    if (!fs.existsSync(RECENT_ALERT_SNAPSHOT_PATH)) {
      return [];
    }
    const rows = JSON.parse(fs.readFileSync(RECENT_ALERT_SNAPSHOT_PATH, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function _writeRecentAlertSnapshot(row: RecentAlertSnapshotRow): void {
  try {
    fs.mkdirSync(path.dirname(RECENT_ALERT_SNAPSHOT_PATH), { recursive: true });
    const current = _readRecentAlertSnapshot();
    const next = [row, ...current].slice(0, RECENT_ALERT_LIMIT);
    fs.writeFileSync(RECENT_ALERT_SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[hub-alarm-client] recent alert snapshot 저장 실패: ${(error as Error).message}`);
  }
}

function _recordRecentAlertSnapshot({
  message,
  team,
  alertLevel,
  fromBot,
  payload,
}: {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  payload: unknown;
}): void {
  _writeRecentAlertSnapshot({
    from_bot: fromBot,
    team,
    event_type: _extractEventType(message, payload),
    alert_level: alertLevel,
    message,
    status: 'sent',
    created_at: new Date().toISOString(),
  });
}

async function _sendInlineTelegram({ message, team, fromBot, topicId, groupId, inlineKeyboard }: InlineTelegramInput) {
  const botToken = team === 'darwin'
    ? (await _getDarwinTelegramBotToken()) || (await _getTelegramBotToken())
    : await _getTelegramBotToken();
  if (!botToken || !groupId) {
    console.warn('[hub-alarm-client] inline telegram 발송 실패: bot token/group id 미설정');
    return { ok: false, error: 'no_telegram_token_or_group' };
  }

  try {
    const payload = {
      chat_id: groupId,
      text: `[${fromBot}→${team}] ${message}`,
      message_thread_id: topicId || undefined,
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    };

    for (let attempt = 1; attempt <= TELEGRAM_RETRY_ATTEMPTS; attempt += 1) {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) {
        return { ok: true, status: res.status, body };
      }

      if (res.status === 429 && attempt < TELEGRAM_RETRY_ATTEMPTS) {
        const delayMs = _resolveTelegramRetryDelayMs(res, body, 3000);
        console.warn(`[hub-alarm-client] inline telegram 429 — ${delayMs}ms 후 재시도`);
        await _sleep(delayMs);
        continue;
      }

      return { ok: false, status: res.status, body };
    }

    return { ok: false, error: 'telegram_retry_exhausted' };
  } catch (e) {
    const error = e as ExecError;
    console.warn(`[hub-alarm-client] inline telegram 실패: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function postAlarm({
  message,
  team = 'general',
  alertLevel = 2,
  fromBot = 'unknown',
  sessionKey,
  payload = null,
  inlineKeyboard = null,
}: PostAlarmInput) {
  const safeFromBot = _normalizeAlertText(fromBot) || 'unknown';
  const requestedTeam = _normalizeAlertText(team) || 'general';
  const safeMessage = _normalizeAlertText(message) || '유효한 본문 없음 (payload 확인 필요)';
  const normalizedTeam = TEAM_TOPIC[requestedTeam as keyof typeof TEAM_TOPIC] || 'general';
  const prefix = alertLevel >= 3 ? `🚨 [긴급 alert_level=${alertLevel}] ` : '';
  const { groupId, topicIds } = await _getTopicInfo();
  const topicId = topicIds?.[normalizedTeam] || topicIds?.general || null;
  const to = groupId
    ? (topicId ? `${groupId}:topic:${topicId}` : groupId)
    : undefined;

  if (Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0) {
    const inlineResult = await _sendInlineTelegram({
      message: `${prefix}${safeMessage}`,
      team: requestedTeam,
      fromBot: safeFromBot,
      topicId,
      groupId,
      inlineKeyboard,
    });
    if (inlineResult?.ok) {
      _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
    }
    return inlineResult;
  }

  const hubDirectBlocked = _readBooleanEnv('HUB_ALARM_SKIP_DIRECT', 'OPENCLAW_CLIENT_SKIP_HUB_ALARM');
  if (!hubDirectBlocked) {
    const hubResult = await _postAlarmViaHub({
      message: safeMessage,
      team: requestedTeam,
      alertLevel,
      fromBot: safeFromBot,
      payload,
    });
    if (hubResult?.ok) {
      _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
      return hubResult;
    }
    if (hubResult?.error) {
      if (!_isLegacyOpenClawFallbackEnabled()) {
        console.warn(`[hub-alarm-client] hub alarm failed (legacy OpenClaw fallback disabled): ${hubResult.error}`);
        return {
          ok: false,
          source: 'hub_alarm',
          error: hubResult.error,
          fallback: 'disabled',
        };
      }
      console.warn(`[hub-alarm-client] hub alarm legacy fallback: ${hubResult.error}`);
    }
  }

  if (!_isLegacyOpenClawFallbackEnabled()) {
    return {
      ok: false,
      source: 'hub_alarm',
      error: hubDirectBlocked ? 'hub_alarm_skipped' : 'hub_alarm_not_delivered',
      fallback: 'disabled',
    };
  }

  const token = await _getToken();
  if (!token) {
    console.warn('[hub-alarm-client] hooks_token 미설정');
    return { ok: false, error: 'no_token' };
  }

  const requestPayload = {
    message: `${prefix}[${safeFromBot}→${requestedTeam}] ${safeMessage}`,
    name: safeFromBot,
    agentId: 'main',
    ...(sessionKey ? { sessionKey } : {}),
    deliver: true,
    channel: 'telegram',
    to,
    wakeMode: 'now',
    timeoutSeconds: TIMEOUT_MS / 1000,
  };

  try {
    const res = await fetch(HOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    if (res.ok) {
      _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const error = e as ExecError;
    console.warn(`[hub-alarm-client] legacy webhook 실패: ${error.message}`);
    const fallback = _postHookViaCurl({ token, payload: requestPayload });
    if (fallback.ok) {
      console.warn('[hub-alarm-client] legacy webhook curl 폴백 성공');
      _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
      return fallback;
    }
    return { ok: false, error: fallback.error || error.message };
  }
}

export function readRecentAlertSnapshot(limit = 10): RecentAlertSnapshotRow[] {
  return _readRecentAlertSnapshot().slice(0, Math.max(0, limit));
}

export function _testOnly_isHubAlarmDeliveryAccepted(response: { ok: boolean }, body: any): boolean {
  return _isHubAlarmDeliveryAccepted(response as Response, body);
}

export function _testOnly_isLegacyOpenClawFallbackEnabled(): boolean {
  return _isLegacyOpenClawFallbackEnabled();
}

export function _testOnly_isLegacyWebhookFallbackEnabled(): boolean {
  return _isLegacyOpenClawFallbackEnabled();
}
